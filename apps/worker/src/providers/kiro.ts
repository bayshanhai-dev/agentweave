import { spawn } from "node:child_process";
import { providerError, redactSecrets } from "./errors.js";
import { buildKiroCommand, isCliIssuedSessionId } from "./kiro-command.js";
import { normalizeKiroJsonl } from "./kiro-jsonl.js";
import type { ProviderAdapter, ProviderCapabilities, ProviderError, ProviderRunEvent, ProviderRunInput, ProviderRunResult, ProviderSession, ProviderUsage, SessionCheckpoint } from "./types.js";

export type KiroProcess = { code: Promise<number | null>; stdout: AsyncIterable<string | Uint8Array>; stderr: AsyncIterable<string | Uint8Array>; kill: (signal?: NodeJS.Signals) => void };
export type KiroProcessRunner = (command: string, args: string[], options?: { cwd?: string; stdin?: string }) => KiroProcess;
export type KiroConfig = { command?: string; model?: string; timeoutMs?: number; killGraceMs?: number };

const defaultRunner: KiroProcessRunner = (command, args, options) => {
  const child = spawn(command, args, { shell: false, stdio: ["pipe", "pipe", "pipe"], ...(options?.cwd ? { cwd: options.cwd } : {}) });
  child.stdin.end(options?.stdin ?? "");
  const code = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, stdout: child.stdout, stderr: child.stderr, kill: (signal) => { child.kill(signal); } };
};

type ActiveTurn = { process: KiroProcess; cancelled: boolean; timedOut: boolean; exited: boolean; forceKillTimer?: ReturnType<typeof setTimeout> };

function classifyFailure(message: string, correlationId: string, extra: Partial<ProviderError> = {}): ProviderError {
  const safe = redactSecrets(message.trim());
  if (/unauthori[sz]ed|authentication|credentials?|log\s*in|sign\s*in/i.test(safe)) {
    return providerError(safe, "authentication", "user-action-required", { ...extra, code: "KIRO_AUTHENTICATION", provider: "kiro", correlationId });
  }
  return providerError(safe, "provider", "retryable", { code: "KIRO_ERROR", provider: "kiro", correlationId, ...extra });
}

async function drain(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  const decoder = new TextDecoder(); let output = "";
  for await (const chunk of stream) {
    output += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (output.length > 64 * 1024) output = output.slice(-(64 * 1024));
  }
  return output + decoder.decode();
}

export class KiroAdapter implements ProviderAdapter {
  readonly name = "kiro";
  readonly capabilities: ProviderCapabilities = { streaming: true, toolCalls: false, resume: true, cancellation: true };
  private readonly active = new Map<string, ActiveTurn>();
  private readonly config: { command: string; model?: string; timeoutMs: number; killGraceMs: number };

  constructor(private readonly runner: KiroProcessRunner = defaultRunner, config: KiroConfig = {}) {
    this.config = { command: config.command ?? "kiro-cli", timeoutMs: config.timeoutMs ?? 120_000, killGraceMs: config.killGraceMs ?? 2_000, ...(config.model ? { model: config.model } : {}) };
  }

  /** Number of subprocess-backed turns currently owned by this adapter. */
  get activeTurnCount(): number { return this.active.size; }

  async createSession(input: { model?: string; workspacePath?: string } = {}): Promise<ProviderSession> {
    const now = new Date().toISOString();
    // Locally minted ids carry a `local-` marker: they name our bookkeeping
    // record, not a CLI session, and must never reach --resume-id. The id is
    // replaced by the CLI-issued one as soon as the stream reports it.
    return { provider: this.name, providerSessionId: `local-${crypto.randomUUID()}`, status: "active", createdAt: now, updatedAt: now,
      ...(input.model ?? this.config.model ? { model: input.model ?? this.config.model } : {}), ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}) };
  }

  async resumeSession(session: ProviderSession): Promise<ProviderSession> { return { ...session, status: "active", updatedAt: new Date().toISOString() }; }
  async checkpoint(session: ProviderSession): Promise<SessionCheckpoint> {
    return { provider: session.provider, providerSessionId: session.providerSessionId, ...(session.providerTurnId ? { providerTurnId: session.providerTurnId } : {}), sequence: 0, state: {}, createdAt: new Date().toISOString() };
  }

  async *run(input: ProviderRunInput): AsyncGenerator<ProviderRunEvent, ProviderRunResult> {
    const suppliedSession = input.session;
    let session = suppliedSession ?? await this.createSession({ model: input.model, workspacePath: input.workspacePath });
    const turnId = crypto.randomUUID(); const correlationId = input.correlationId ?? crypto.randomUUID();
    // Resume only a session the CLI itself issued. A supplied session object
    // is not evidence of that: the worker passes its bookkeeping record on
    // every turn, including the first, and its id may be locally minted.
    const resuming = suppliedSession !== undefined && isCliIssuedSessionId(session.providerSessionId);
    const invocation = buildKiroCommand(this.config, input, session, resuming);
    let process: KiroProcess;
    try { process = this.runner(invocation.command, invocation.args, { ...invocation.options, stdin: invocation.stdin }); }
    catch (cause) {
      const error = providerError(`Unable to start Kiro: ${cause instanceof Error ? cause.message : String(cause)}`, "transport", "retryable", { code: "KIRO_START", provider: this.name, correlationId });
      yield { type: "turn.failed", turnId, error, correlationId }; throw Object.assign(new Error(error.message), error);
    }

    const active: ActiveTurn = { process, cancelled: false, timedOut: false, exited: false }; this.active.set(turnId, active);
    const stderrPromise = drain(process.stderr);
    const exitPromise = process.code.then(
      (code) => ({ code }),
      (cause: unknown) => ({ cause }),
    ).finally(() => { active.exited = true; if (active.forceKillTimer) clearTimeout(active.forceKillTimer); });
    const timeout = setTimeout(() => { active.timedOut = true; this.terminate(active); }, this.config.timeoutMs);
    yield { type: "turn.started", turnId, correlationId };

    let text = ""; let completed = false; let usage: ProviderUsage | undefined; let reportedError: ProviderError | undefined;
    let sessionEventEmitted = false;
    try {
      for await (const event of normalizeKiroJsonl(process.stdout)) {
        if (event.type === "content") { text += event.text; yield { type: "turn.delta", turnId, text: event.text, correlationId }; }
        if (event.type === "completion") { completed = true; if (event.text !== undefined) text = event.text; }
        if (event.type === "session") {
          // ACP records repeat the session id on every line; surface it once
          // per turn, and adopt the CLI-issued id for the persisted session.
          const resumeConfirmed = resuming && !sessionEventEmitted && event.sessionId === session.providerSessionId;
          if (event.sessionId !== session.providerSessionId) {
            session = { ...session, providerSessionId: event.sessionId, updatedAt: new Date().toISOString() };
          }
          if (!sessionEventEmitted) {
            sessionEventEmitted = true;
            yield { type: resumeConfirmed ? "session.resumed" : "session.started", session, correlationId };
          }
        }
        if (event.type === "usage") { usage = event.usage; yield { type: "usage.updated", turnId, usage, correlationId }; }
        if (event.type === "error") { reportedError = classifyFailure(event.message, correlationId, event.code ? { code: event.code } : {}); yield { type: "provider.error", error: reportedError, correlationId }; }
      }
      const [exit, stderr] = await Promise.all([exitPromise, stderrPromise]);
      if ("cause" in exit) throw exit.cause;
      const exitCode = exit.code;
      if (active.cancelled) { const error = providerError("Kiro turn cancelled", "cancelled", "non-retryable", { code: "KIRO_CANCELLED", provider: this.name, correlationId }); throw Object.assign(new Error(error.message), error); }
      if (active.timedOut) { const error = providerError(`Kiro timed out after ${this.config.timeoutMs}ms`, "timeout", "retryable", { code: "KIRO_TIMEOUT", provider: this.name, correlationId }); yield { type: "turn.failed", turnId, error, correlationId }; throw Object.assign(new Error(error.message), error); }
      if (exitCode !== 0 || reportedError || !completed) {
        const message = reportedError?.message ?? (stderr.trim() || (exitCode !== 0 ? `Kiro exited with code ${exitCode}` : "Kiro stream ended without a completion event"));
        const error = reportedError ?? classifyFailure(message, correlationId, { code: exitCode !== 0 ? "KIRO_EXIT" : "KIRO_INCOMPLETE" });
        yield { type: "turn.failed", turnId, error, correlationId }; throw Object.assign(new Error(error.message), error);
      }
      const finalSession: ProviderSession = { ...session, providerTurnId: turnId, status: "completed", updatedAt: new Date().toISOString() };
      yield { type: "turn.completed", turnId, text, ...(usage ? { usage } : {}), correlationId };
      return { turnId, text, session: finalSession, ...(usage ? { usage } : {}) };
    } catch (cause) {
      if (!active.exited) this.terminate(active);
      if (cause && typeof cause === "object" && "code" in cause && String(cause.code).startsWith("KIRO_")) throw cause;
      const error = providerError(`Kiro subprocess failed: ${cause instanceof Error ? cause.message : String(cause)}`, "transport", "retryable", { code: "KIRO_TRANSPORT", provider: this.name, correlationId });
      yield { type: "turn.failed", turnId, error, correlationId };
      throw Object.assign(new Error(error.message), error);
    }
    finally { clearTimeout(timeout); if (active.forceKillTimer) clearTimeout(active.forceKillTimer); this.active.delete(turnId); }
  }

  async *cancel(_session: ProviderSession, turnId: string, correlationId?: string): AsyncGenerator<ProviderRunEvent> {
    const active = this.active.get(turnId); if (active) { active.cancelled = true; this.terminate(active); }
    yield { type: "turn.cancelled", turnId, ...(correlationId ? { correlationId } : {}) };
  }

  private terminate(active: ActiveTurn): void {
    if (active.exited) return; active.process.kill("SIGTERM");
    if (!active.forceKillTimer) active.forceKillTimer = setTimeout(() => { if (!active.exited) active.process.kill("SIGKILL"); }, this.config.killGraceMs);
  }
}

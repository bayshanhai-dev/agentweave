import { providerError } from "./errors.js";
import type { ProviderAdapter, ProviderCapabilities, ProviderRunEvent, ProviderRunInput, ProviderRunResult, ProviderSession, ProviderUsage, SessionCheckpoint } from "./types.js";

export type CodexTransport = { request(method: string, params: Record<string, unknown>, correlationId: string): Promise<{ id?: string; result?: Record<string, unknown>; error?: { message: string; code?: string } }>; events?(correlationId: string): AsyncIterable<Record<string, unknown>>; cancel?(sessionId: string, turnId: string, correlationId: string): Promise<void> };

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  for (const key of ["text", "delta", "output_text", "message"]) {
    if (typeof item[key] === "string") return item[key] as string;
  }
  if (Array.isArray(item.content)) return item.content.map(textFrom).join("");
  if (item.item) return textFrom(item.item);
  if (item.result) return textFrom(item.result);
  return "";
}
function completedAgentMessageText(value: Record<string, unknown>): string | undefined {
  if (value.type !== "item.completed" || !value.item || typeof value.item !== "object") return undefined;
  const item = value.item as Record<string, unknown>;
  if (item.type !== "agent_message" && item.type !== "agentMessage") return undefined;
  return textFrom(item);
}
function usableCodexModel(model?: string): string | undefined {
  return model && !["deterministic", "mock", "mock-model"].includes(model.trim().toLowerCase()) ? model : undefined;
}
function usageFrom(value: unknown): ProviderUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const container = (candidate.usage ?? candidate.tokenUsage ?? candidate.token_usage) as Record<string, unknown> | undefined;
  if (!container || typeof container !== "object") return undefined;
  // Codex App Server reports cumulative thread totals plus the most recent turn.
  // Prefer `last` so summing completed turns produces a correct per-agent total.
  const raw = (container.last && typeof container.last === "object" ? container.last : container) as Record<string, unknown>;
  const numberAt = (...keys: string[]) => { for (const key of keys) { const value = raw[key]; if (typeof value === "number" && Number.isFinite(value)) return value; } return undefined; };
  const inputTokens = numberAt("inputTokens", "input_tokens", "promptTokens", "prompt_tokens");
  const outputTokens = numberAt("outputTokens", "output_tokens", "completionTokens", "completion_tokens");
  const totalTokens = numberAt("totalTokens", "total_tokens") ?? (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
  const costUsd = numberAt("costUsd", "cost_usd", "cost");
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && costUsd === undefined) return undefined;
  return { source: "provider", ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
}

export class CodexAppServerAdapter implements ProviderAdapter {
  readonly name = "codex"; readonly capabilities: ProviderCapabilities = { streaming: true, toolCalls: true, resume: true, cancellation: true };
  constructor(private readonly transport?: CodexTransport, private readonly config: { url?: string; command?: string; model?: string; inactivityTimeoutMs?: number; maxDurationMs?: number } = {}) {}
  private requireTransport(): CodexTransport { if (!this.transport) throw new Error("Codex App Server transport is not configured"); return this.transport; }
  async createSession(input: { model?: string; workspacePath?: string } = {}): Promise<ProviderSession> { const c = crypto.randomUUID(); const model = usableCodexModel(input.model ?? this.config.model); const r = await this.requireTransport().request("thread/start", { ...(model ? { model } : {}), ...(input.workspacePath ? { cwd: input.workspacePath } : {}), approvalPolicy: process.env.AGENTWEAVE_CODEX_APPROVAL_POLICY ?? "never", sandbox: process.env.AGENTWEAVE_CODEX_SANDBOX ?? "workspace-write" }, c); const thread = r.result?.thread as Record<string, unknown> | undefined; const sessionId = thread?.id ?? r.result?.threadId; if (r.error || !sessionId) throw new Error(r.error?.message ?? "Codex thread creation failed"); const now = new Date().toISOString(); return { provider: this.name, ...(model ? { model } : {}), providerSessionId: String(sessionId), status: "active", createdAt: now, updatedAt: now }; }
  async resumeSession(session: ProviderSession): Promise<ProviderSession> { const r = await this.requireTransport().request("thread/resume", { threadId: session.providerSessionId, ...(session.workspacePath ? { cwd: session.workspacePath } : {}), ...(session.model ? { model: session.model } : {}), approvalPolicy: process.env.AGENTWEAVE_CODEX_APPROVAL_POLICY ?? "never", sandbox: process.env.AGENTWEAVE_CODEX_SANDBOX ?? "workspace-write" }, crypto.randomUUID()); if (r.error) throw new Error(r.error.message); return { ...session, status: "active", updatedAt: new Date().toISOString() }; }
  async checkpoint(session: ProviderSession): Promise<SessionCheckpoint> { return { provider: session.provider, providerSessionId: session.providerSessionId, ...(session.providerTurnId ? { providerTurnId: session.providerTurnId } : {}), sequence: 0, state: {}, createdAt: new Date().toISOString() }; }
  async *run(input: ProviderRunInput): AsyncGenerator<ProviderRunEvent, ProviderRunResult> { const t = this.requireTransport(); const session = input.session ?? await this.createSession({ model: input.model, ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}) }); const correlationId = input.correlationId ?? crypto.randomUUID(); const r = await t.request("turn/start", { threadId: session.providerSessionId, input: [{ type: "text", text: input.input }], ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) }, correlationId); if (r.error) { const error = providerError(r.error.message, "provider", "retryable", { code: r.error.code ?? "CODEX_ERROR", provider: this.name, correlationId }); yield { type: "provider.error", error, correlationId }; throw new Error(error.message); } const turnId = String(r.result?.turnId ?? r.id ?? correlationId); yield { type: "turn.started", turnId, correlationId }; let streamedText = ""; let finalAgentMessageText: string | undefined; let usage: ProviderUsage | undefined;
    if (t.events) {
      const iterator = t.events(session.providerSessionId)[Symbol.asyncIterator]();
      const inactivityTimeoutMs = this.config.inactivityTimeoutMs ?? Number(process.env.AGENTWEAVE_TURN_INACTIVITY_TIMEOUT_MS ?? 600_000);
      const maxDurationMs = this.config.maxDurationMs ?? Number(process.env.AGENTWEAVE_TURN_MAX_DURATION_MS ?? 900_000);
      const deadline = Date.now() + maxDurationMs;
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const remainingDurationMs = deadline - Date.now();
        let next: IteratorResult<Record<string, unknown>> | "inactivity" | "max-duration";
        if (remainingDurationMs <= 0) {
          next = "max-duration";
        } else {
          const timeoutKind = remainingDurationMs <= inactivityTimeoutMs ? "max-duration" : "inactivity";
          const timeoutMs = Math.min(inactivityTimeoutMs, remainingDurationMs);
          const timeout = new Promise<"inactivity" | "max-duration">((resolve) => { timer = setTimeout(() => resolve(timeoutKind), timeoutMs); });
          try { next = await Promise.race([iterator.next(), timeout]); }
          finally { if (timer) clearTimeout(timer); }
        }
        if (next === "inactivity" || next === "max-duration") {
          void iterator.return?.();
          void t.cancel?.(session.providerSessionId, turnId, correlationId).catch(() => undefined);
          const maxDurationExpired = next === "max-duration";
          const error = providerError(maxDurationExpired
            ? `Codex turn exceeded maximum duration of ${maxDurationMs}ms`
            : `Codex turn produced no events for ${inactivityTimeoutMs}ms`, "provider", "retryable", { code: maxDurationExpired ? "CODEX_TURN_MAX_DURATION" : "CODEX_TURN_INACTIVITY_TIMEOUT", provider: this.name, correlationId });
          yield { type: "provider.error", error, correlationId };
          throw Object.assign(new Error(error.message), error);
        }
        if (next.done) break;
        const e = next.value;
        const nextUsage = usageFrom(e); if (nextUsage) usage = nextUsage; const type = String(e.type); const extracted = textFrom(e); const completedText = completedAgentMessageText(e); if (completedText !== undefined) { finalAgentMessageText = completedText; if (!streamedText) { streamedText = completedText; yield { type: "turn.delta", turnId, text: completedText, correlationId }; } } else if (type === "turn.delta" || type.includes("delta")) { if (extracted) { streamedText += extracted; yield { type: "turn.delta", turnId, text: extracted, correlationId }; } } else if (type === "tool.started" || type === "tool.completed") yield { type, turnId, toolName: String(e.toolName ?? "unknown"), ...(e.output ? { output: String(e.output) } : {}), correlationId } as ProviderRunEvent;
      }
    }
    const text = finalAgentMessageText ?? streamedText;
    if (!text.trim()) { const error = providerError("Codex completed without text output", "provider", "retryable", { code: "CODEX_EMPTY_OUTPUT", provider: this.name, correlationId }); yield { type: "turn.failed", turnId, error, correlationId }; throw new Error(error.message); } if (usage) yield { type: "usage.updated", turnId, usage, correlationId }; yield { type: "turn.completed", turnId, text, ...(usage ? { usage } : {}), correlationId }; return { turnId, text, session: { ...session, providerSessionId: String(r.result?.threadId ?? session.providerSessionId), providerTurnId: turnId, status: "completed", updatedAt: new Date().toISOString() }, ...(usage ? { usage } : {}) }; }
  async *cancel(session: ProviderSession, turnId: string, correlationId = crypto.randomUUID()): AsyncGenerator<ProviderRunEvent> { await this.requireTransport().cancel?.(session.providerSessionId, turnId, correlationId); yield { type: "turn.cancelled", turnId, correlationId }; }
}

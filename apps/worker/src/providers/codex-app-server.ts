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
  constructor(private readonly transport?: CodexTransport, private readonly config: { url?: string; command?: string; model?: string } = {}) {}
  private requireTransport(): CodexTransport { if (!this.transport) throw new Error("Codex App Server transport is not configured"); return this.transport; }
  async createSession(input: { model?: string; workspacePath?: string } = {}): Promise<ProviderSession> { const c = crypto.randomUUID(); const model = usableCodexModel(input.model ?? this.config.model); const r = await this.requireTransport().request("thread/start", { ...(model ? { model } : {}), ...(input.workspacePath ? { cwd: input.workspacePath } : {}) }, c); const thread = r.result?.thread as Record<string, unknown> | undefined; const sessionId = thread?.id ?? r.result?.threadId; if (r.error || !sessionId) throw new Error(r.error?.message ?? "Codex thread creation failed"); const now = new Date().toISOString(); return { provider: this.name, ...(model ? { model } : {}), providerSessionId: String(sessionId), status: "active", createdAt: now, updatedAt: now }; }
  async resumeSession(session: ProviderSession): Promise<ProviderSession> { const r = await this.requireTransport().request("thread/resume", { threadId: session.providerSessionId, ...(session.workspacePath ? { cwd: session.workspacePath } : {}), ...(session.model ? { model: session.model } : {}) }, crypto.randomUUID()); if (r.error) throw new Error(r.error.message); return { ...session, status: "active", updatedAt: new Date().toISOString() }; }
  async checkpoint(session: ProviderSession): Promise<SessionCheckpoint> { return { provider: session.provider, providerSessionId: session.providerSessionId, ...(session.providerTurnId ? { providerTurnId: session.providerTurnId } : {}), sequence: 0, state: {}, createdAt: new Date().toISOString() }; }
  async *run(input: ProviderRunInput): AsyncGenerator<ProviderRunEvent, ProviderRunResult> { const t = this.requireTransport(); const session = input.session ?? await this.createSession({ model: input.model, ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}) }); const correlationId = input.correlationId ?? crypto.randomUUID(); const r = await t.request("turn/start", { threadId: session.providerSessionId, input: [{ type: "text", text: input.input }], ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) }, correlationId); if (r.error) { const error = providerError(r.error.message, "provider", "retryable", { code: r.error.code ?? "CODEX_ERROR", provider: this.name, correlationId }); yield { type: "provider.error", error, correlationId }; throw new Error(error.message); } const turnId = String(r.result?.turnId ?? r.id ?? correlationId); yield { type: "turn.started", turnId, correlationId }; let text = ""; let usage: ProviderUsage | undefined; if (t.events) for await (const e of t.events(session.providerSessionId)) { const nextUsage = usageFrom(e); if (nextUsage) usage = nextUsage; const type = String(e.type); const extracted = textFrom(e); if (type === "turn.delta" || type.includes("delta")) { if (extracted) { text += extracted; yield { type: "turn.delta", turnId, text: extracted, correlationId }; } } else if (type === "tool.started" || type === "tool.completed") yield { type, turnId, toolName: String(e.toolName ?? "unknown"), ...(e.output ? { output: String(e.output) } : {}), correlationId } as ProviderRunEvent; else if (extracted && extracted !== text) { const delta = extracted.startsWith(text) ? extracted.slice(text.length) : extracted; text += delta; if (delta) yield { type: "turn.delta", turnId, text: delta, correlationId }; } } if (!text.trim()) { const error = providerError("Codex completed without text output", "provider", "retryable", { code: "CODEX_EMPTY_OUTPUT", provider: this.name, correlationId }); yield { type: "turn.failed", turnId, error, correlationId }; throw new Error(error.message); } if (usage) yield { type: "usage.updated", turnId, usage, correlationId }; yield { type: "turn.completed", turnId, text, ...(usage ? { usage } : {}), correlationId }; return { turnId, text, session: { ...session, providerSessionId: String(r.result?.threadId ?? session.providerSessionId), providerTurnId: turnId, status: "completed", updatedAt: new Date().toISOString() }, ...(usage ? { usage } : {}) }; }
  async *cancel(session: ProviderSession, turnId: string, correlationId = crypto.randomUUID()): AsyncGenerator<ProviderRunEvent> { await this.requireTransport().cancel?.(session.providerSessionId, turnId, correlationId); yield { type: "turn.cancelled", turnId, correlationId }; }
}

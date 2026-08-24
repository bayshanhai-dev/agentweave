import type { CodexTransport } from "./codex-app-server.js";

export class CodexHttpTransport implements CodexTransport {
  private readonly sessions = new Map<string, { workspacePath?: string; model?: string }>();
  private readonly eventsBySession = new Map<string, Record<string, unknown>[]>();
  private readonly timeoutMs = Number(process.env.PROVIDER_REQUEST_TIMEOUT_MS ?? 120_000);
  constructor(private readonly baseUrl: string, private readonly token = process.env.CODEX_BRIDGE_TOKEN) {}
  private async parseResponse(response: Response): Promise<{ body: { id?: string; result?: Record<string, unknown>; error?: { message: string; code?: string }; text?: string; stderr?: string; exitCode?: number | null; threadId?: string; events?: Record<string, unknown>[]; errorText?: string }; status: number }> {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 401) return { status: response.status, body: { error: { message: "Codex bridge authentication failed: check CODEX_BRIDGE_TOKEN on both Worker and host bridge", code: "CODEX_BRIDGE_AUTHENTICATION_FAILED" } } };
    return { status: response.status, body: body as never };
  }
  async request(method: string, params: Record<string, unknown>, correlationId: string) {
    if (method === "initialize") return { result: {} };
    if (process.env.CODEX_BRIDGE_MODE === "app-server") return this.requestAppServer(method, params, correlationId);
    if (method === "thread/start") { const id = `bridge-${correlationId}`; this.sessions.set(id, { ...(params.cwd ? { workspacePath: String(params.cwd) } : {}), ...(params.model ? { model: String(params.model) } : {}) }); return { result: { thread: { id } } }; }
    if (method === "thread/resume") { const id = String(params.threadId); this.sessions.set(id, { ...(params.cwd ? { workspacePath: String(params.cwd) } : {}), ...(params.model ? { model: String(params.model) } : {}) }); return { result: { threadId: id } }; }
    if (method === "turn/interrupt") return { result: {} };
    if (method !== "turn/start") return { error: { message: `Unsupported bridge method: ${method}`, code: "BRIDGE_METHOD_UNSUPPORTED" } };
    const sessionId = String(params.threadId); const session = this.sessions.get(sessionId); if (!session) return { error: { message: "Bridge session not found", code: "BRIDGE_SESSION_NOT_FOUND" } };
    const input = Array.isArray(params.input) ? String((params.input[0] as { text?: string } | undefined)?.text ?? "") : String(params.input ?? "");
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/codex/execute`, { method: "POST", signal: AbortSignal.timeout(this.timeoutMs), headers: { "content-type": "application/json", "x-correlation-id": correlationId, ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify({ prompt: input, workspacePath: session.workspacePath, ...(session.model ? { model: session.model } : {}), ...(sessionId.startsWith("bridge-") ? {} : { threadId: sessionId }) }) });
    const parsed = await this.parseResponse(response); const body = parsed.body as { text?: string; stderr?: string; exitCode?: number | null; threadId?: string; error?: string | { message?: string; code?: string } }; const error = typeof body.error === "string" ? { message: body.error, code: "CODEX_BRIDGE_EXECUTION_FAILED" } : body.error; if (!response.ok || body.error || body.exitCode !== 0) return { error: { message: error?.message ?? body.stderr ?? "Codex bridge execution failed", code: error?.code ?? "CODEX_BRIDGE_EXECUTION_FAILED" } };
    if (body.threadId) this.sessions.set(body.threadId, session);
    this.eventsBySession.set(sessionId, [{ type: "turn.delta", text: body.text ?? "" }, { type: "turn.completed" }]); return { result: { turnId: `turn-${correlationId}`, ...(body.threadId ? { threadId: body.threadId } : {}) } };
  }
  private async requestAppServer(method: string, params: Record<string, unknown>, correlationId: string) {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/codex/app-server/request`, { method: "POST", headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify({ method, params, correlationId }) });
    const parsed = await this.parseResponse(response); return parsed.body as { id?: string; result?: Record<string, unknown>; error?: { message: string; code?: string } };
  }
  async *events(sessionId: string): AsyncIterable<Record<string, unknown>> {
    if (process.env.CODEX_BRIDGE_MODE === "app-server") {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/codex/app-server/events/${encodeURIComponent(sessionId)}`, { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
      if (!response.ok || !response.body) { const parsed = await this.parseResponse(response); throw new Error(parsed.body.error?.message ?? "Codex bridge event authentication failed"); }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) { if (line.trim()) yield JSON.parse(line) as Record<string, unknown>; } }
      if (buffer.trim()) yield JSON.parse(buffer) as Record<string, unknown>;
      return;
    }
    for (const event of this.eventsBySession.get(sessionId) ?? []) yield event; this.eventsBySession.delete(sessionId);
  }
  async cancel(): Promise<void> { /* one-shot bridge execution is bounded by the child process */ }
}

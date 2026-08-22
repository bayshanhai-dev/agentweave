import type { CodexTransport } from "./codex-app-server.js";

export class CodexHttpTransport implements CodexTransport {
  private readonly sessions = new Map<string, { workspacePath?: string; model?: string }>();
  private readonly eventsBySession = new Map<string, Record<string, unknown>[]>();
  constructor(private readonly baseUrl: string, private readonly token = process.env.CODEX_BRIDGE_TOKEN) {}
  async request(method: string, params: Record<string, unknown>, correlationId: string) {
    if (method === "initialize") return { result: {} };
    if (method === "thread/start") { const id = `bridge-${correlationId}`; this.sessions.set(id, { ...(params.cwd ? { workspacePath: String(params.cwd) } : {}), ...(params.model ? { model: String(params.model) } : {}) }); return { result: { thread: { id } } }; }
    if (method === "thread/resume") return { result: { threadId: String(params.threadId) } };
    if (method === "turn/interrupt") return { result: {} };
    if (method !== "turn/start") return { error: { message: `Unsupported bridge method: ${method}`, code: "BRIDGE_METHOD_UNSUPPORTED" } };
    const sessionId = String(params.threadId); const session = this.sessions.get(sessionId); if (!session) return { error: { message: "Bridge session not found", code: "BRIDGE_SESSION_NOT_FOUND" } };
    const input = Array.isArray(params.input) ? String((params.input[0] as { text?: string } | undefined)?.text ?? "") : String(params.input ?? "");
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/codex/execute`, { method: "POST", headers: { "content-type": "application/json", "x-correlation-id": correlationId, ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify({ prompt: input, workspacePath: session.workspacePath, ...(session.model ? { model: session.model } : {}) }) });
    const body = await response.json() as { text?: string; stderr?: string; exitCode?: number | null; error?: string }; if (!response.ok || body.error || body.exitCode !== 0) return { error: { message: body.error ?? body.stderr ?? "Codex bridge execution failed", code: "CODEX_BRIDGE_EXECUTION_FAILED" } };
    this.eventsBySession.set(sessionId, [{ type: "turn.delta", text: body.text ?? "" }, { type: "turn.completed" }]); return { result: { turnId: `turn-${correlationId}` } };
  }
  async *events(sessionId: string): AsyncIterable<Record<string, unknown>> { for (const event of this.eventsBySession.get(sessionId) ?? []) yield event; this.eventsBySession.delete(sessionId); }
  async cancel(): Promise<void> { /* one-shot bridge execution is bounded by the child process */ }
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type RpcResult = { id?: string; result?: Record<string, unknown>; error?: { message: string; code?: string } };
type Pending = { resolve: (value: RpcResult) => void; reject: (error: Error) => void };

/** Host-owned long-lived Codex App Server process. */
export class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly queues = new Map<string, Record<string, unknown>[]>();
  private initialized?: Promise<void>;
  private sequence = 0;

  constructor(private readonly command = "codex") {
    this.child = spawn(command, ["app-server", "--stdio"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
    this.child.on("error", (error) => { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); });
  }
  async request(method: string, params: Record<string, unknown>, correlationId: string): Promise<RpcResult> {
    if (method !== "initialize") await this.initialize();
    const id = `${correlationId}:${++this.sequence}`;
    const response = new Promise<RpcResult>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }
  async *events(threadId: string): AsyncIterable<Record<string, unknown>> {
    for (;;) { const queue = this.queues.get(threadId) ?? []; const event = queue.shift(); if (event) { if (queue.length) this.queues.set(threadId, queue); else this.queues.delete(threadId); yield event; if (event.type === "turn.completed" || event.type === "turn.failed") return; continue; } await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  private async initialize(): Promise<void> { if (this.initialized) return this.initialized; this.initialized = (async () => { const response = await this.request("initialize", { clientInfo: { name: "agentweave-host-runtime-bridge", version: "0.0.0" }, capabilities: {} }, "initialize"); if (response.error) throw new Error(response.error.message); this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`); })(); return this.initialized; }
  private receive(line: string): void {
    let message: Record<string, unknown>; try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (typeof message.id === "string" && this.pending.has(message.id)) { const pending = this.pending.get(message.id)!; this.pending.delete(message.id); const error = message.error as RpcResult["error"] | undefined; pending.resolve({ id: message.id, result: (message.result ?? {}) as Record<string, unknown>, ...(error ? { error } : {}) }); return; }
    const params = (message.params ?? {}) as Record<string, unknown>; const threadId = String(params.threadId ?? params.thread_id ?? ""); if (!threadId) return;
    const method = String(message.method ?? ""); const event = method === "item/agentMessage/delta" ? { type: "turn.delta", text: String(params.delta ?? params.text ?? "") } : method === "turn/completed" ? { type: "turn.completed" } : method === "turn/failed" ? { type: "turn.failed", error: params.error } : method === "item/started" ? { type: "tool.started", toolName: String(params.itemType ?? "tool") } : undefined;
    if (event) this.queues.set(threadId, [...(this.queues.get(threadId) ?? []), event]);
  }
}

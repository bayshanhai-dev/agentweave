import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { CodexTransport } from "./codex-app-server.js";

type Pending = { resolve: (value: { id?: string; result?: Record<string, unknown>; error?: { message: string; code?: string } }) => void; reject: (error: Error) => void };

export class CodexStdioTransport implements CodexTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly queues = new Map<string, Array<Record<string, unknown>>>();
  private readonly waiters = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  private sequence = 0;
  private initialized?: Promise<void>;
  constructor(private readonly command = "codex", private readonly args = ["app-server", "--stdio"]) {
    this.child = spawn(this.command, this.args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.receive(line));
    this.child.on("error", (error) => { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); });
  }
  async request(method: string, params: Record<string, unknown>, correlationId: string) {
    if (method !== "initialize") await this.initialize();
    const id = `${correlationId}:${++this.sequence}`;
    const response = new Promise<{ id?: string; result?: Record<string, unknown>; error?: { message: string; code?: string } }>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }
  private async initialize(): Promise<void> { if (this.initialized) return this.initialized; this.initialized = (async () => { const response = await this.request("initialize", { clientInfo: { name: "agentweave", version: "0.0.0" }, capabilities: {} }, "initialize"); if (response.error) throw new Error(response.error.message); this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`); })(); return this.initialized; }
  async *events(correlationId: string): AsyncIterable<Record<string, unknown>> {
    for (;;) { const event = await this.next(correlationId); yield event; if (event.type === "turn.completed" || event.type === "turn.failed") return; }
  }
  async cancel(sessionId: string, turnId: string, correlationId: string): Promise<void> { await this.request("turn/interrupt", { threadId: sessionId, turnId }, correlationId); }
  private receive(line: string): void {
    let message: Record<string, unknown>; try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const pendingId = typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : undefined;
    if (pendingId !== undefined && this.pending.has(pendingId)) { const pending = this.pending.get(pendingId)!; this.pending.delete(pendingId); if (message.error) pending.resolve({ id: pendingId, error: message.error as { message: string; code?: string } }); else pending.resolve({ id: pendingId, result: (message.result ?? {}) as Record<string, unknown> }); return; }
    if (typeof message.method === "string" && pendingId !== undefined) {
      const supported = message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval";
      const response = supported ? { jsonrpc: "2.0", id: message.id, result: { decision: "accept" } } : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unsupported client request: ${message.method}` } };
      this.child.stdin.write(`${JSON.stringify(response)}\n`);
      return;
    }
    const params = (message.params ?? {}) as Record<string, unknown>; const threadId = String(params.threadId ?? params.thread_id ?? "");
    if (!threadId) return;
    const type = String(message.method ?? ""); const event = type === "item/agentMessage/delta" ? { type: "turn.delta", text: String(params.delta ?? params.text ?? "") } : type === "item/completed" || type === "item/agentMessage/completed" ? { type: "item.completed", item: params.item ?? params } : type === "turn/completed" ? { type: "turn.completed", text: params.text ?? params.output_text ?? params.result } : type === "turn/failed" ? { type: "turn.failed", error: params.error } : type === "item/started" ? { type: "tool.started", toolName: String(params.itemType ?? "tool") } : undefined;
    if (event) { const waiter = this.waiters.get(threadId)?.shift(); if (waiter) waiter(event); else this.queues.set(threadId, [...(this.queues.get(threadId) ?? []), event]); }
  }
  private next(threadId: string): Promise<Record<string, unknown>> { const queued = this.queues.get(threadId)?.shift(); if (queued) return Promise.resolve(queued); return new Promise((resolve) => this.waiters.set(threadId, [...(this.waiters.get(threadId) ?? []), resolve])); }
}

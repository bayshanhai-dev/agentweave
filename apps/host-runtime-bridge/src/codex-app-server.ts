import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type RpcResult = { id?: string; result?: Record<string, unknown>; error?: { message: string; code?: string } };
type Pending = { resolve: (value: RpcResult) => void; reject: (error: Error) => void };

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  for (const key of ["text", "delta", "output_text", "message"]) if (typeof item[key] === "string") return item[key] as string;
  if (Array.isArray(item.content)) return item.content.map(textFrom).join("");
  if (item.item) return textFrom(item.item);
  if (item.result) return textFrom(item.result);
  return "";
}

/** Host-owned long-lived Codex App Server process. */
export class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly queues = new Map<string, Record<string, unknown>[]>();
  private readonly streamedAgentMessages = new Set<string>();
  private initialized?: Promise<void>;
  private sequence = 0;

  constructor(private readonly command = "codex") {
    this.child = spawn(command, ["app-server", "--stdio"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
    createInterface({ input: this.child.stderr }).on("line", (line) => console.error(JSON.stringify({ event: "codex.app_server.stderr", command, line })));
    this.child.on("error", (error) => { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); });
    this.child.on("exit", (code, signal) => { const error = new Error(`Codex App Server exited (${code ?? "null"}, ${signal ?? "no signal"})`); for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); });
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
    const method = String(message.method ?? "");
    const item = params.item && typeof params.item === "object" ? params.item as Record<string, unknown> : undefined;
    const itemType = String(item?.type ?? params.itemType ?? "");
    const normalizedItemType = itemType.replaceAll("_", "").toLowerCase();
    const isAgentMessage = method.includes("agentMessage") || normalizedItemType === "agentmessage";
    const isHumanMessage = normalizedItemType === "usermessage" || normalizedItemType === "humanmessage";
    const completedText = textFrom(params);
    const deltaText = textFrom(params.delta ?? params.text);
    const tokenUsage = params.tokenUsage ?? params.token_usage ?? params.usage;
    const event = method === "thread/tokenUsage/updated"
      ? { type: "usage.updated", ...(tokenUsage && typeof tokenUsage === "object" ? { tokenUsage } : {}) }
      : method === "item/agentMessage/delta"
      ? (deltaText ? (this.streamedAgentMessages.add(threadId), { type: "turn.delta", text: deltaText }) : undefined)
      : (method === "item/agentMessage/completed" || (method === "item/completed" && isAgentMessage))
        ? (!this.streamedAgentMessages.has(threadId) && completedText ? { type: "turn.delta", text: completedText } : undefined)
        : method === "turn/completed"
          ? { type: "turn.completed", ...(completedText ? { text: completedText } : {}), ...(tokenUsage && typeof tokenUsage === "object" ? { tokenUsage } : {}) }
          : method === "turn/failed"
            ? { type: "turn.failed", error: params.error }
            : method === "item/started" && !isAgentMessage && !isHumanMessage
              ? { type: "tool.started", toolName: itemType || "tool" }
              : undefined;
    if (event) this.queues.set(threadId, [...(this.queues.get(threadId) ?? []), event]);
    if (method === "turn/completed" || method === "turn/failed") this.streamedAgentMessages.delete(threadId);
  }
}

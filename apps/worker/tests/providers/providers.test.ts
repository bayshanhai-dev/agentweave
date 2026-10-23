import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter, type ProcessResult } from "../../src/providers/claude-code.js";
import { CodexAppServerAdapter, type CodexTransport } from "../../src/providers/codex-app-server.js";
import { CodexStdioTransport } from "../../src/providers/codex-stdio-transport.js";
import { providerError, redactSecrets } from "../../src/providers/errors.js";
import { MockProviderAdapter } from "../../src/providers/mock.js";
import { createProviderFromEnv } from "../../src/providers/registry.js";
import type { ProviderRunEvent } from "../../src/providers/types.js";

async function collect<T>(stream: AsyncGenerator<ProviderRunEvent, T>) {
  const events: ProviderRunEvent[] = [];
  let step = await stream.next();
  while (!step.done) { events.push(step.value); step = await stream.next(); }
  return { events, result: step.value };
}

async function* chunks(values: string[]) { for (const value of values) yield value; }

afterEach(() => vi.unstubAllEnvs());

describe("provider adapters", () => {
  it("keeps a deterministic mock happy path and normalized event shape", async () => {
    const provider = new MockProviderAdapter();
    const session = await provider.createSession({ model: "mock-model" });
    const run = await collect(provider.run({ session, input: "hello", correlationId: "c-1" }));
    expect(run.events.map((event) => event.type)).toEqual(["turn.started", "turn.delta", "turn.completed"]);
    expect(run.events.every((event) => typeof event.type === "string")).toBe(true);
    expect(run.result.session.provider).toBe("mock");
  });

  it("drives a deterministic scenario from template role ids instead of SDLC names", async () => {
    const provider = new MockProviderAdapter();
    const input = "[agentweave template=research-synthesis phase=lead recipient=research-lead lead=research-lead planning=researcher execution=synthesizer review=research-reviewer]\nFrame the question.";
    const run = await collect(provider.run({ input, idempotencyKey: "research-lead" }));
    expect(run.result.structuredResult).toMatchObject({
      tasks: [{ ownerRole: "researcher" }],
      messages: [{ recipientRole: "researcher", taskId: "lead-next" }],
    });
    expect(run.result.structuredResult?.messages[0]?.content).toContain("template=research-synthesis phase=planning recipient=researcher");
  });

  it("drives the short-video creator scenario through its own planning role", async () => {
    const provider = new MockProviderAdapter();
    const input = "[agentweave template=short-video-creator phase=lead recipient=creator-lead lead=creator-lead planning=trend-researcher execution=video-producer review=audience-reviewer]\nFrame the audience brief.";
    const run = await collect(provider.run({ input, idempotencyKey: "creator-lead" }));
    expect(run.result.structuredResult).toMatchObject({
      tasks: [{ ownerRole: "trend-researcher" }],
      messages: [{ recipientRole: "trend-researcher", taskId: "lead-next" }],
    });
    expect(run.result.structuredResult?.messages[0]?.content).toContain("template=short-video-creator phase=planning recipient=trend-researcher");
  });

  it("does not duplicate an idempotent completed turn", async () => {
    const provider = new MockProviderAdapter(); const session = await provider.createSession();
    const first = await collect(provider.run({ session, input: "same", idempotencyKey: "key-1" }));
    const second = await collect(provider.run({ session, input: "same", idempotencyKey: "key-1" }));
    expect(second.result.turnId).toBe(first.result.turnId);
    expect(second.result.text).toBe(first.result.text);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.type).toBe("turn.completed");
  });

  it("normalizes mock failures as retryable", async () => {
    const provider = new MockProviderAdapter({ fail: true }); const session = await provider.createSession();
    const stream = provider.run({ session, input: "fail" });
    await expect(collect(stream)).rejects.toThrow("Mock provider failure");
  });

  it("supports cancellation and resume", async () => {
    const provider = new MockProviderAdapter(); const session = await provider.createSession();
    expect((await provider.resumeSession(session)).status).toBe("active");
    const cancelled = await collect(provider.cancel(session, "turn-1", "corr-1"));
    expect(cancelled.events[0]).toEqual({ type: "turn.cancelled", turnId: "turn-1", correlationId: "corr-1" });
  });

  it("selects configured providers and rejects invalid configuration", () => {
    expect(createProviderFromEnv({ AGENTWEAVE_PROVIDER: "mock" }).name).toBe("mock");
    expect(createProviderFromEnv({ AGENTWEAVE_PROVIDER: "codex" }, { codexTransport: fakeCodexTransport() }).name).toBe("codex");
    expect(createProviderFromEnv({ AGENTWEAVE_PROVIDER: "kiro" }).name).toBe("kiro");
    expect(() => createProviderFromEnv({ AGENTWEAVE_PROVIDER: "unknown" })).toThrow("Unsupported AGENTWEAVE_PROVIDER");
  });

  it("correlates Codex requests and translates streamed events", async () => {
    const requests: Array<{ method: string; correlationId: string }> = [];
    const transport = fakeCodexTransport(requests);
    const provider = new CodexAppServerAdapter(transport, { model: "gpt-test" });
    const run = await collect(provider.run({ input: "hello", correlationId: "corr-codex" }));
    expect(requests).toEqual([{ method: "thread/start", correlationId: expect.any(String) }, { method: "turn/start", correlationId: "corr-codex" }]);
    expect(run.events.map((event) => event.type)).toEqual(["turn.started", "turn.delta", "tool.started", "tool.completed", "turn.delta", "turn.completed"]);
    expect(run.events.every((event) => "correlationId" in event)).toBe(true);
    expect(run.result.text).toBe("hello world");
  });

  it("configures Codex thread approval and sandbox defaults and env overrides", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const transport: CodexTransport = { async request(method, params) { requests.push({ method, params }); return { result: { thread: { id: "thread-1" } } }; } };
    const provider = new CodexAppServerAdapter(transport);
    const session = await provider.createSession();
    await provider.resumeSession(session);
    expect(requests.map(({ params }) => params)).toEqual([
      expect.objectContaining({ approvalPolicy: "never", sandbox: "workspace-write" }),
      expect.objectContaining({ approvalPolicy: "never", sandbox: "workspace-write" }),
    ]);

    vi.stubEnv("AGENTWEAVE_CODEX_APPROVAL_POLICY", "on-request");
    vi.stubEnv("AGENTWEAVE_CODEX_SANDBOX", "danger-full-access");
    await provider.createSession();
    await provider.resumeSession(session);
    expect(requests.slice(2).map(({ params }) => params)).toEqual([
      expect.objectContaining({ approvalPolicy: "on-request", sandbox: "danger-full-access" }),
      expect.objectContaining({ approvalPolicy: "on-request", sandbox: "danger-full-access" }),
    ]);
  });

  it("accepts file-change approval requests and rejects unknown client requests", () => {
    const writes: string[] = [];
    const receiver = (CodexStdioTransport.prototype as unknown as { receive(this: unknown, line: string): void }).receive;
    const transport = { child: { stdin: { write: (line: string) => writes.push(line) } }, pending: new Map(), queues: new Map(), waiters: new Map() };
    receiver.call(transport, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "item/fileChange/requestApproval", params: {} }));
    receiver.call(transport, JSON.stringify({ jsonrpc: "2.0", id: "unknown-1", method: "custom/unknown", params: {} }));
    expect(writes.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: "2.0", id: 7, result: { decision: "accept" } },
      { jsonrpc: "2.0", id: "unknown-1", error: { code: -32601, message: "unsupported client request: custom/unknown" } },
    ]);
  });

  it("forwards Codex token usage notifications instead of dropping them", () => {
    const receiver = (CodexStdioTransport.prototype as unknown as { receive(this: unknown, line: string): void }).receive;
    const transport = { child: { stdin: { write: () => undefined } }, pending: new Map(), queues: new Map(), waiters: new Map() };
    receiver.call(transport, JSON.stringify({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "thread-usage", turnId: "turn-1", tokenUsage: { total: { inputTokens: 900, outputTokens: 90, totalTokens: 990 }, last: { inputTokens: 120, outputTokens: 30, totalTokens: 150 } } } }));
    expect(transport.queues.get("thread-usage")).toEqual([
      { type: "thread/tokenUsage/updated", tokenUsage: { total: { inputTokens: 900, outputTokens: 90, totalTokens: 990 }, last: { inputTokens: 120, outputTokens: 30, totalTokens: 150 } } },
    ]);
  });

  it("keeps final App Server item text when no delta was emitted", async () => {
    const transport: CodexTransport = {
      async request(method) { return method === "thread/start" ? { result: { thread: { id: "thread-1" } } } : { result: { turnId: "turn-1" } }; },
      async *events() { yield { type: "item.completed", item: { type: "agent_message", content: [{ type: "text", text: "Final inspection summary" }] } }; },
    };
    const run = await collect(new CodexAppServerAdapter(transport).run({ input: "inspect" }));
    expect(run.result.text).toBe("Final inspection summary");
    expect(run.events.at(-1)).toMatchObject({ type: "turn.completed", text: "Final inspection summary" });
  });

  it("uses only the last completed agent message as Codex turn text", async () => {
    const json = '{"schemaVersion":1,"summary":"Final result","insights":[],"tasks":[],"messages":[]}';
    const transport: CodexTransport = {
      async request(method) { return method === "thread/start" ? { result: { thread: { id: "thread-1" } } } : { result: { turnId: "turn-1" } }; },
      async *events() {
        yield { type: "item.completed", item: { type: "user_message", content: [{ type: "text", text: "Task prompt" }] } };
        yield { type: "item.completed", item: { type: "agent_message", content: [{ type: "text", text: "Draft response" }] } };
        yield { type: "turn.delta", text: json };
        yield { type: "item.completed", item: { type: "agent_message", content: [{ type: "text", text: json }] } };
      },
    };
    const run = await collect(new CodexAppServerAdapter(transport).run({ input: "inspect" }));
    expect(run.result.text).toBe(json);
    expect(run.result.text).not.toContain("Task prompt");
  });

  it("captures Codex App Server token usage from the latest turn", async () => {
    const transport: CodexTransport = {
      async request(method) { return method === "thread/start" ? { result: { thread: { id: "thread-usage" } } } : { result: { turnId: "turn-usage" } }; },
      async *events() {
        yield { type: "turn.delta", text: "done" };
        yield { type: "usage.updated", tokenUsage: { total: { inputTokens: 900, outputTokens: 90, totalTokens: 990 }, last: { inputTokens: 120, outputTokens: 30, totalTokens: 150 } } };
      },
    };
    const run = await collect(new CodexAppServerAdapter(transport).run({ input: "inspect", correlationId: "corr-usage" }));
    expect(run.result.usage).toMatchObject({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    expect(run.events.at(-2)).toMatchObject({ type: "usage.updated", usage: { totalTokens: 150 } });
  });

  it("fails and cancels a Codex turn when its event stream stalls", async () => {
    let cancelled: { sessionId: string; turnId: string; correlationId: string } | undefined;
    const transport: CodexTransport = {
      async request(method) { return method === "thread/start" ? { result: { thread: { id: "thread-stalled" } } } : { result: { turnId: "turn-stalled" } }; },
      async *events() { await new Promise(() => undefined); },
      async cancel(sessionId, turnId, correlationId) { cancelled = { sessionId, turnId, correlationId }; },
    };
    const stream = new CodexAppServerAdapter(transport, { inactivityTimeoutMs: 10 }).run({ input: "inspect", correlationId: "corr-stalled" });
    expect(await stream.next()).toMatchObject({ value: { type: "turn.started" }, done: false });
    expect(await stream.next()).toMatchObject({ value: { type: "provider.error", error: { code: "CODEX_TURN_INACTIVITY_TIMEOUT", category: "provider", retry: "retryable" } }, done: false });
    await expect(stream.next()).rejects.toMatchObject({ code: "CODEX_TURN_INACTIVITY_TIMEOUT", category: "provider", retry: "retryable" });
    expect(cancelled).toEqual({ sessionId: "thread-stalled", turnId: "turn-stalled", correlationId: "corr-stalled" });
  });

  it("fails and cancels a Codex turn at its total-duration cap despite streaming events", async () => {
    let cancelled: { sessionId: string; turnId: string; correlationId: string } | undefined;
    const transport: CodexTransport = {
      async request(method) { return method === "thread/start" ? { result: { thread: { id: "thread-long" } } } : { result: { turnId: "turn-long" } }; },
      async *events() { for (;;) { await new Promise((resolve) => setTimeout(resolve, 5)); yield { type: "turn.delta", text: "." }; } },
      async cancel(sessionId, turnId, correlationId) { cancelled = { sessionId, turnId, correlationId }; },
    };
    const stream = new CodexAppServerAdapter(transport, { inactivityTimeoutMs: 100, maxDurationMs: 20 }).run({ input: "inspect", correlationId: "corr-long" });
    expect(await stream.next()).toMatchObject({ value: { type: "turn.started" }, done: false });
    let event = await stream.next();
    while (!event.done && event.value.type === "turn.delta") event = await stream.next();
    expect(event).toMatchObject({ value: { type: "provider.error", error: { code: "CODEX_TURN_MAX_DURATION", category: "provider", retry: "retryable" } }, done: false });
    await expect(stream.next()).rejects.toMatchObject({ code: "CODEX_TURN_MAX_DURATION", category: "provider", retry: "retryable" });
    expect(cancelled).toEqual({ sessionId: "thread-long", turnId: "turn-long", correlationId: "corr-long" });
  });

  it("streams Claude stdout, exposes stderr, and uses argv safely", async () => {
    let command = ""; let args: string[] = [];
    const runner = (receivedCommand: string, receivedArgs: string[]): ProcessResult => { command = receivedCommand; args = receivedArgs; return { code: Promise.resolve(0), stdout: chunks(["hello", " world"]), stderr: chunks(["diagnostic"]), kill: () => undefined }; };
    const provider = new ClaudeCodeAdapter(runner, { command: "claude-test", timeoutMs: 1000 });
    const run = await collect(provider.run({ input: "hello; rm -rf /" }));
    expect(command).toBe("claude-test"); expect(args).toContain("hello; rm -rf /"); expect(args).not.toContain("/bin/sh");
    expect(run.result.text).toBe("hello world");
    expect(run.events.some((event) => event.type === "provider.error")).toBe(true);
  });

  it("normalizes provider error categories and redacts secrets", () => {
    expect(providerError("timed out", "timeout", "retryable").retry).toBe("retryable");
    expect(providerError("bad key", "authentication", "user-action-required").category).toBe("authentication");
    expect(redactSecrets("Authorization: Bearer secret123 api_key=abc")).toContain("[REDACTED]");
    expect(redactSecrets("Authorization: Bearer secret123 api_key=abc")).not.toContain("secret123");
  });
});

function fakeCodexTransport(requests: Array<{ method: string; correlationId: string }> = []): CodexTransport {
  return {
    async request(method, _params, correlationId) { requests.push({ method, correlationId }); return method === "thread/start" ? { result: { thread: { id: "codex-session-1" } } } : { result: { turnId: "codex-turn-1" } }; },
    async *events() { yield { type: "turn.delta", text: "hello " }; yield { type: "tool.started", toolName: "search" }; yield { type: "tool.completed", toolName: "search", output: "ok" }; yield { type: "turn.delta", text: "world" }; },
    async cancel() { return undefined; },
  };
}

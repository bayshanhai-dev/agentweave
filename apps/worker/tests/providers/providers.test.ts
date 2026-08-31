import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, type ProcessResult } from "../../src/providers/claude-code.js";
import { CodexAppServerAdapter, type CodexTransport } from "../../src/providers/codex-app-server.js";
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

describe("provider adapters", () => {
  it("keeps a deterministic mock happy path and normalized event shape", async () => {
    const provider = new MockProviderAdapter();
    const session = await provider.createSession({ model: "mock-model" });
    const run = await collect(provider.run({ session, input: "hello", correlationId: "c-1" }));
    expect(run.events.map((event) => event.type)).toEqual(["turn.started", "turn.delta", "turn.completed"]);
    expect(run.events.every((event) => typeof event.type === "string")).toBe(true);
    expect(run.result.session.provider).toBe("mock");
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

  it("keeps final App Server item text when no delta was emitted", async () => {
    const transport: CodexTransport = {
      async request(method) { return method === "thread/start" ? { result: { thread: { id: "thread-1" } } } : { result: { turnId: "turn-1" } }; },
      async *events() { yield { type: "item.completed", item: { type: "agent_message", content: [{ type: "text", text: "Final inspection summary" }] } }; },
    };
    const run = await collect(new CodexAppServerAdapter(transport).run({ input: "inspect" }));
    expect(run.result.text).toBe("Final inspection summary");
    expect(run.events.at(-1)).toMatchObject({ type: "turn.completed", text: "Final inspection summary" });
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

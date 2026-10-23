import { describe, expect, it } from "vitest";
import { normalizeKiroJsonl, normalizeKiroRecord } from "../../src/providers/kiro-jsonl.js";

async function* chunks(values: Array<string | Uint8Array>) { for (const value of values) yield value; }
async function collect(values: Array<string | Uint8Array>) {
  const result = [];
  for await (const event of normalizeKiroJsonl(chunks(values))) result.push(event);
  return result;
}

describe("Kiro stream-json normalization", () => {
  it("parses records incrementally across arbitrary chunk boundaries", async () => {
    const events = await collect([
      '{"type":"content","data":{"text":"hel',
      'lo"}}\n{"type":"completion"',
      ',"data":{"text":"hello"}}\n',
    ]);
    expect(events).toEqual([{ type: "content", text: "hello" }, { type: "completion", text: "hello" }]);
  });

  it("ignores malformed lines, unknown events, fields, and invalid known records", async () => {
    const events = await collect([
      'not json\n{"type":"future.event","text":"leak"}\n',
      '{"type":"content","data":{"text":7,"unknown":"ignored"}}\n',
      '{"type":"content","data":{"text":"safe","unknown":{"secret":true}}}',
    ]);
    expect(events).toEqual([{ type: "content", text: "safe" }]);
  });

  it("normalizes verified session, usage, and error fields only", () => {
    expect(normalizeKiroRecord({ type: "session.started", data: { session_id: "session-1", extra: true } })).toEqual([{ type: "session", sessionId: "session-1" }]);
    expect(normalizeKiroRecord({ type: "usage", data: { usage: { input_tokens: 10, outputTokens: 4, total_tokens: 14, invented: 99 } } })).toEqual([{ type: "usage", usage: { source: "provider", inputTokens: 10, outputTokens: 4, totalTokens: 14 } }]);
    expect(normalizeKiroRecord({ type: "error", data: { error: { message: "denied", code: "AUTH" } } })).toEqual([{ type: "error", message: "denied", code: "AUTH" }]);
    expect(normalizeKiroRecord({ type: "usage", data: { usage: { total_tokens: "14" } } })).toEqual([]);
    expect(normalizeKiroRecord({ type: "session", data: { sessionId: 123 } })).toEqual([]);
  });

  it("normalizes the ACP shapes kiro-cli 2.x actually emits", async () => {
    const events = await collect([
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_abc123","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}}\n',
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_abc123","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"hmm"}}}}\n',
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_abc123","update":{"sessionUpdate":"tool_call","content":{"type":"text","text":"not text output"}}}}\n',
      '{"runFinished":{"finalText":"Hello world","stopReason":"end_turn","usage":{"creditsUsed":0.42}}}\n',
    ]);
    expect(events).toEqual([
      { type: "session", sessionId: "sess_abc123" },
      { type: "content", text: "Hello" },
      { type: "session", sessionId: "sess_abc123" },
      { type: "session", sessionId: "sess_abc123" },
      { type: "usage", usage: { source: "provider", credits: 0.42 } },
      { type: "completion", text: "Hello world" },
    ]);
  });

  it("normalizes run errors and flattened session updates", () => {
    expect(normalizeKiroRecord({ runError: { message: "Session not found", code: "SESSION" } })).toEqual([
      { type: "error", message: "Session not found", code: "SESSION" },
    ]);
    expect(
      normalizeKiroRecord({ sessionUpdate: "agent_message_chunk", sessionId: "sess_1", content: { type: "text", text: "flat" } }),
    ).toEqual([
      { type: "session", sessionId: "sess_1" },
      { type: "content", text: "flat" },
    ]);
    expect(normalizeKiroRecord({ id: 2, result: { stopReason: "end_turn" } })).toEqual([{ type: "completion" }]);
  });

  it("reports metering usage as credits, never as tokens", () => {
    expect(normalizeKiroRecord({ type: "usage", data: { meteringUsage: { creditsUsed: 3 } } })).toEqual([
      { type: "usage", usage: { source: "provider", credits: 3 } },
    ]);
    expect(normalizeKiroRecord({ runFinished: { meteringUsage: 1.5 } })).toEqual([
      { type: "usage", usage: { source: "provider", credits: 1.5 } },
      { type: "completion" },
    ]);
  });

  it("decodes split UTF-8 without corrupting content", async () => {
    const bytes = new TextEncoder().encode('{"type":"content","text":"café"}\n');
    const split = bytes.indexOf(0xc3) + 1;
    expect(await collect([bytes.slice(0, split), bytes.slice(split)])).toEqual([{ type: "content", text: "café" }]);
  });

  it("drops an oversized untrusted line and resumes at the next record", async () => {
    const events = await collect(["x".repeat(1024 * 1024 + 1), '\n{"type":"content","text":"recovered"}\n']);
    expect(events).toEqual([{ type: "content", text: "recovered" }]);
  });
});

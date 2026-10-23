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
    expect(normalizeKiroRecord({ type: "session.started", data: { session_id: "session-1", extra: true } })).toEqual({ type: "session", sessionId: "session-1" });
    expect(normalizeKiroRecord({ type: "usage", data: { usage: { input_tokens: 10, outputTokens: 4, total_tokens: 14, invented: 99 } } })).toEqual({ type: "usage", usage: { source: "provider", inputTokens: 10, outputTokens: 4, totalTokens: 14 } });
    expect(normalizeKiroRecord({ type: "error", data: { error: { message: "denied", code: "AUTH" } } })).toEqual({ type: "error", message: "denied", code: "AUTH" });
    expect(normalizeKiroRecord({ type: "usage", data: { usage: { total_tokens: "14" } } })).toBeUndefined();
    expect(normalizeKiroRecord({ type: "session", data: { sessionId: 123 } })).toBeUndefined();
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

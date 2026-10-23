import { describe, expect, it } from "vitest";
import { normalizeKiroRecord } from "../../../../src/providers/kiro-jsonl.js";

describe("Kiro assumption-based compatibility (opt-in)", () => {
  it("accepts unverified aliases and snake_case field spellings", () => {
    expect(normalizeKiroRecord({ type: "content.delta", content: "hello" })).toEqual({ type: "content", text: "hello" });
    expect(normalizeKiroRecord({ type: "completed", content: "done" })).toEqual({ type: "completion", text: "done" });
    expect(normalizeKiroRecord({ type: "session.created", data: { session_id: "assumed-session" } })).toEqual({ type: "session", sessionId: "assumed-session" });
    expect(normalizeKiroRecord({ type: "usage.updated", data: { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3, cost_usd: 0.01 } } })).toEqual({
      type: "usage",
      usage: { source: "provider", inputTokens: 2, outputTokens: 1, totalTokens: 3, costUsd: 0.01 },
    });
  });
});

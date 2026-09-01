import { describe, expect, it } from "vitest";
import { tokenUsage } from "../src/agentUsage.js";

describe("agent token usage", () => {
  it("does not count progressive updates for the same turn twice", () => {
    expect(tokenUsage([
      { correlationId: "turn-1", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.01 } },
      { correlationId: "turn-1", usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180, costUsd: 0.02 } },
    ])).toEqual({ inputTokens: 100, outputTokens: 80, totalTokens: 180, costUsd: 0.02, reported: true });
  });

  it("adds usage from independent turns", () => {
    expect(tokenUsage([
      { correlationId: "turn-1", usage: { inputTokens: 100, outputTokens: 50 } },
      { correlationId: "turn-2", usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 } },
    ])).toEqual({ inputTokens: 140, outputTokens: 60, totalTokens: 200, costUsd: 0, reported: true });
  });

  it("ignores unidentifiable usage events", () => {
    expect(tokenUsage([{ usage: { totalTokens: 99 } }])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      reported: false,
    });
  });
});

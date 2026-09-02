import { describe, expect, it } from "vitest";
import { parseAgentTurnResult } from "../../src/providers/agent-turn-result.js";

describe("AgentTurnResult parsing", () => {
  it("parses JSON and fenced JSON", () => {
    const result = parseAgentTurnResult('```json\n{"summary":"done","tasks":[]}\n```');
    expect(result.summary).toBe("done");
    expect(result.schemaVersion).toBe(1);
  });

  it("keeps marker output as a compatibility fallback", () => {
    expect(parseAgentTurnResult("[PROPOSE_COMPLETE] ready").decision).toEqual({ action: "complete", reason: "ready" });
    expect(parseAgentTurnResult("[HUMAN_BLOCKED] choose a provider").humanBlock?.question).toBe("choose a provider");
  });

  it("rejects empty output with an actionable error", () => {
    expect(() => parseAgentTurnResult("  ")).toThrow(/empty or malformed/);
  });
});

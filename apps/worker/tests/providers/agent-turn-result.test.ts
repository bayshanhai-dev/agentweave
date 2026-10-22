import { describe, expect, it } from "vitest";
import { parseAgentTurnResult } from "../../src/providers/agent-turn-result.js";

describe("AgentTurnResult parsing", () => {
  it("parses JSON and fenced JSON", () => {
    const json = '{"summary":"done","tasks":[]}';
    expect(parseAgentTurnResult(json).summary).toBe("done");
    const fencedResult = parseAgentTurnResult(`\`\`\`json\n${json}\n\`\`\``);
    expect(fencedResult.summary).toBe("done");
    expect(fencedResult.schemaVersion).toBe(1);
  });

  it("normalizes insight summary to content", () => {
    const result = parseAgentTurnResult(
      '{"summary":"reviewed","insights":[{"id":"qa-1","kind":"critique","summary":"Add a bounded validation step"}]}'
    );
    expect(result.insights[0].content).toBe("Add a bounded validation step");
  });

  it("wraps schema-invalid declared JSON as a prose summary", () => {
    const text = '{"summary":"reviewed","insights":[{"id":"qa-1","kind":"critique"}]}';
    const result = parseAgentTurnResult(text);
    expect(result.summary).toBe(text);
    expect(result.insights).toEqual([]);
  });

  it("keeps marker output as a compatibility fallback", () => {
    expect(parseAgentTurnResult("[PROPOSE_COMPLETE] ready").decision).toEqual({ action: "complete", reason: "ready" });
    expect(parseAgentTurnResult("[HUMAN_BLOCKED] choose a provider").humanBlock?.question).toBe("choose a provider");
  });

  it("rejects empty output with an actionable error", () => {
    expect(() => parseAgentTurnResult("  ")).toThrow(/empty or malformed/);
  });

  it("extracts JSON embedded in prose (real LLM style)", () => {
    // Real LLMs often add explanatory text before/after the JSON.
    const result = parseAgentTurnResult(
      `Here's my proposal:\n{"schemaVersion":1,"summary":"Use haiku","insights":[{"id":"p1","kind":"proposal","content":"Use a 5-7-5 haiku","confidence":0.9}],"tasks":[],"messages":[]}\nLet me know what you think.`
    );
    expect(result.summary).toBe("Use haiku");
    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].kind).toBe("proposal");
  });

  it("parses the first of two duplicated JSON objects", () => {
    const json = '{"schemaVersion":1,"summary":"done with {nested} and \\"escaped\\" text","insights":[],"tasks":[],"messages":[]}';
    expect(parseAgentTurnResult(json + json).summary).toBe('done with {nested} and "escaped" text');
  });

  it("prefers fenced JSON over embedded JSON", () => {
    const result = parseAgentTurnResult(
      `Some text {"schemaVersion":1,"summary":"wrong","insights":[],"tasks":[],"messages":[]} more text\n\`\`\`json\n{"schemaVersion":1,"summary":"right","insights":[],"tasks":[],"messages":[]}\n\`\`\``
    );
    expect(result.summary).toBe("right");
  });
});

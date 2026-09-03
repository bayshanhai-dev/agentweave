import { describe, expect, it } from "vitest";
import { agentTurnResultSchema } from "../src/index.js";

describe("AgentTurnResult contract", () => {
  it("applies defaults to a valid structured result", () => {
    const result = agentTurnResultSchema.parse({
      summary: "Plan is ready",
      tasks: [{ id: "task-1", title: "Implement", ownerRole: "coder" }],
    });
    expect(result.schemaVersion).toBe(1);
    expect(result.tasks[0]?.acceptanceCriteria).toEqual([]);
    expect(result.insights).toEqual([]);
  });

  it("rejects malformed results with actionable paths", () => {
    const parsed = agentTurnResultSchema.safeParse({ summary: "", tasks: [{ title: "missing id", ownerRole: "coder" }] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.path.includes("summary"))).toBe(true);
  });
});

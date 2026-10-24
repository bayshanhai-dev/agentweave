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
    expect(result.tasks[0]?.dependencies).toBeUndefined();
    expect(result.insights).toEqual([]);
  });

  it("accepts sibling dependency references in structured task specs", () => {
    const result = agentTurnResultSchema.parse({
      summary: "Plan is ready",
      tasks: [
        { id: "research", title: "Research", ownerRole: "analyst", acceptanceCriteria: ["research.md cites three sources"], dependencies: [] },
        { id: "draft", title: "Draft", ownerRole: "writer", acceptanceCriteria: ["draft.md is at least 1,000 words"], dependencies: ["research"] },
      ],
    });
    expect(result.tasks[1]?.dependencies).toEqual(["research"]);
  });

  it("accepts one-based ordinal dependency references", () => {
    const result = agentTurnResultSchema.parse({
      summary: "Plan is ready",
      tasks: [
        { id: "research", title: "Research", ownerRole: "analyst" },
        { id: "draft", title: "Draft", ownerRole: "writer", dependencies: [1] },
      ],
    });
    expect(result.tasks[1]?.dependencies).toEqual([1]);
  });

  it("rejects malformed results with actionable paths", () => {
    const parsed = agentTurnResultSchema.safeParse({ summary: "", tasks: [{ title: "missing id", ownerRole: "coder" }] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.path.includes("summary"))).toBe(true);
  });
});

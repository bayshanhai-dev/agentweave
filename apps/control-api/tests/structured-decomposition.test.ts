import { describe, expect, it } from "vitest";
import { parseStructuredTurn, extractStructuredTaskSpecs, InvalidStructuredTurn } from "../src/structured-turn.js";

const result = (tasks: Array<{ id: string; title: string; ownerRole: string; acceptanceCriteria?: string[] }>) =>
  parseStructuredTurn({ schemaVersion: 1, summary: "Implementation decomposition", insights: [], messages: [], tasks });

describe("structured decomposition task extraction", () => {
  it("maps a valid task set to task specs", () => {
    expect(extractStructuredTaskSpecs(result([
      { id: "api", title: "  Build the API  ", ownerRole: "backend", acceptanceCriteria: ["Endpoint is tested"] },
      { id: "ui", title: "Build the UI", ownerRole: "frontend" },
    ]))).toEqual([
      { title: "Build the API", ownerRole: "backend", acceptanceCriteria: ["Endpoint is tested"] },
      { title: "Build the UI", ownerRole: "frontend", acceptanceCriteria: [] },
    ]);
  });

  it("rejects an empty task set", () => {
    expect(() => extractStructuredTaskSpecs(result([]))).toThrow(InvalidStructuredTurn);
  });

  it("rejects an invalid role", () => {
    expect(() => extractStructuredTaskSpecs(result([
      { id: "docs", title: "Write docs", ownerRole: "writer", acceptanceCriteria: [] },
    ]))).toThrow(InvalidStructuredTurn);
  });

  it("rejects a placeholder title", () => {
    expect(() => extractStructuredTaskSpecs(result([
      { id: "placeholder", title: " TASK TITLE ", ownerRole: "qa", acceptanceCriteria: [] },
    ]))).toThrow(InvalidStructuredTurn);
  });

  it("rejects more than twelve tasks", () => {
    expect(() => extractStructuredTaskSpecs(result(Array.from({ length: 13 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      ownerRole: "devops",
      acceptanceCriteria: [],
    }))))).toThrow(InvalidStructuredTurn);
  });
});

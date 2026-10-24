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
      {
        title: "Final validation: run the full project suite",
        ownerRole: "qa",
        dependsOnAllPrevious: true,
        acceptanceCriteria: [
          "Run the project's full test command in the workspace and report the command and its verbatim result",
          "Run the project's full build command when one is defined and report the command and its verbatim result",
          "Report failures without fixing them so the Human can decide whether to complete or reject the Workstream",
        ],
      },
    ]);
  });

  it("moves an existing final validation task to the end and normalizes its requirements", () => {
    const specs = extractStructuredTaskSpecs(result([
      { id: "validation", title: "Final validation", ownerRole: "backend", acceptanceCriteria: ["Keep this criterion"] },
      { id: "api", title: "Build the API", ownerRole: "backend" },
    ]));

    expect(specs.map((spec) => spec.title)).toEqual(["Build the API", "Final validation"]);
    expect(specs.at(-1)).toMatchObject({
      ownerRole: "qa",
      dependsOnAllPrevious: true,
      acceptanceCriteria: expect.arrayContaining([
        "Keep this criterion",
        expect.stringContaining("verbatim result"),
      ]),
    });
  });

  it("rejects an empty task set", () => {
    expect(() => extractStructuredTaskSpecs(result([]))).toThrow(InvalidStructuredTurn);
  });

  it("rejects an invalid role", () => {
    expect(() => extractStructuredTaskSpecs(result([
      { id: "docs", title: "Write docs", ownerRole: "writer", acceptanceCriteria: [] },
    ]))).toThrow(InvalidStructuredTurn);
  });

  it("accepts template-defined owner and review roles", () => {
    expect(extractStructuredTaskSpecs(result([
      { id: "produce", title: "Produce the episode", ownerRole: "producer", acceptanceCriteria: [] },
    ]), new Set(["showrunner", "producer", "editor"]), "editor")).toEqual([
      { title: "Produce the episode", ownerRole: "producer", acceptanceCriteria: [] },
      expect.objectContaining({ ownerRole: "editor", dependsOnAllPrevious: true }),
    ]);
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

  it("appends final validation even when the decomposition uses all twelve input slots", () => {
    const specs = extractStructuredTaskSpecs(result(Array.from({ length: 12 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      ownerRole: "devops",
      acceptanceCriteria: [],
    }))));

    expect(specs).toHaveLength(13);
    expect(specs.at(-1)?.title).toBe("Final validation: run the full project suite");
  });
});

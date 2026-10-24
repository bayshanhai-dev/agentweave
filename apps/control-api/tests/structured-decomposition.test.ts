import { describe, expect, it } from "vitest";
import { resolveTaskDependencies } from "../src/orchestrator.js";
import { parseStructuredTurn, extractStructuredTaskSpecs, InvalidStructuredTurn } from "../src/structured-turn.js";

const result = (tasks: Array<{ id: string; title: string; ownerRole: string; acceptanceCriteria?: string[]; dependencies?: string[] }>) =>
  parseStructuredTurn({ schemaVersion: 1, summary: "Implementation decomposition", insights: [], messages: [], tasks });

describe("structured decomposition task extraction", () => {
  it("maps a valid task set to task specs", () => {
    expect(extractStructuredTaskSpecs(result([
      { id: "api", title: "  Build the API  ", ownerRole: "backend", acceptanceCriteria: ["api.ts exposes a tested GET /episodes endpoint"] },
      { id: "ui", title: "Build the UI", ownerRole: "frontend", dependencies: ["api"], acceptanceCriteria: ["EpisodeList.tsx renders every API result"] },
    ]))).toEqual([
      { title: "Build the API", ownerRole: "backend", acceptanceCriteria: ["api.ts exposes a tested GET /episodes endpoint"], dependencies: [] },
      { title: "Build the UI", ownerRole: "frontend", acceptanceCriteria: ["EpisodeList.tsx renders every API result"], dependencies: ["Build the API"] },
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
      { id: "api", title: "Build the API", ownerRole: "backend", acceptanceCriteria: ["api.ts contains the tested endpoint"] },
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
      { id: "produce", title: "Produce the episode", ownerRole: "producer", acceptanceCriteria: ["episode.md contains at least 1,200 words"] },
    ]), new Set(["showrunner", "producer", "editor"]), "editor")).toEqual([
      { title: "Produce the episode", ownerRole: "producer", acceptanceCriteria: ["episode.md contains at least 1,200 words"], dependencies: [] },
      expect.objectContaining({ ownerRole: "editor", dependsOnAllPrevious: true }),
    ]);
  });

  it("rejects a placeholder title", () => {
    expect(() => extractStructuredTaskSpecs(result([
      { id: "placeholder", title: " TASK TITLE ", ownerRole: "qa", acceptanceCriteria: [] },
    ]))).toThrow(InvalidStructuredTurn);
  });

  it("rejects decomposition tasks without concrete acceptance criteria", () => {
    expect(() => extractStructuredTaskSpecs(result([
      { id: "docs", title: "Write docs", ownerRole: "backend", acceptanceCriteria: [] },
    ]))).toThrow(/requires concrete acceptance criteria/);
  });

  it("validates sibling dependencies and resolves them to durable task ids", () => {
    const specs = extractStructuredTaskSpecs(result([
      { id: "outline", title: "Create the outline", ownerRole: "backend", acceptanceCriteria: ["outline.md has five named sections"] },
      { id: "draft", title: "Write the draft", ownerRole: "frontend", dependencies: ["Create the outline"], acceptanceCriteria: ["draft.md is at least 1,000 words"] },
    ])).slice(0, -1);

    expect(specs[1]?.dependencies).toEqual(["Create the outline"]);
    expect(resolveTaskDependencies(specs, ["task-101", "task-102"])).toEqual([
      [],
      ["task-101"],
    ]);
  });

  it("rejects more than twelve tasks", () => {
    expect(() => extractStructuredTaskSpecs(result(Array.from({ length: 13 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      ownerRole: "devops",
      acceptanceCriteria: [`task-${index}.txt contains at least 200 characters`],
    }))))).toThrow(InvalidStructuredTurn);
  });

  it("appends final validation even when the decomposition uses all twelve input slots", () => {
    const specs = extractStructuredTaskSpecs(result(Array.from({ length: 12 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      ownerRole: "devops",
      acceptanceCriteria: [`task-${index}.txt contains at least 200 characters`],
    }))));

    expect(specs).toHaveLength(13);
    expect(specs.at(-1)?.title).toBe("Final validation: run the full project suite");
  });
});

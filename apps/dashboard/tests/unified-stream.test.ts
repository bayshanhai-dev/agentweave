import { describe, expect, it } from "vitest";
import {
  causalNeighbors,
  isSystemInstruction,
  parseStructuredContent,
  taskShortLabel,
  unifiedStream,
  type StreamInsight,
} from "../src/unified-stream";

const insight = (
  id: string,
  kind: StreamInsight["kind"],
  createdAt: string,
  extra: Partial<StreamInsight> = {},
): StreamInsight => ({
  id,
  kind,
  lifecycle: "accepted",
  authorAgentId: "qa-1",
  content: id,
  confidence: 0.8,
  references: [],
  evidenceIds: [],
  createdAt,
  updatedAt: createdAt,
  ...extra,
});

describe("unified collaboration stream", () => {
  it("orders messages and insights together", () => {
    const items = unifiedStream(
      [{ id: "m1", content: "request", createdAt: "2026-09-04T00:00:02Z" }],
      [insight("i1", "proposal", "2026-09-04T00:00:01Z")],
    );
    expect(items.map((item) => [item.kind, item.id])).toEqual([
      ["insight", "i1"],
      ["message", "m1"],
    ]);
  });

  it("links synthesis to supporting and opposing insights", () => {
    const proposal = insight("proposal", "proposal", "2026-09-04T00:00:01Z");
    const contradiction = insight(
      "against",
      "contradiction",
      "2026-09-04T00:00:02Z",
      { contradictionOf: ["proposal"] },
    );
    const synthesis = insight("final", "synthesis", "2026-09-04T00:00:03Z", {
      references: ["proposal"],
    });
    expect(
      causalNeighbors("final", [
        proposal,
        contradiction,
        synthesis,
      ]).supporting.map((item) => item.id),
    ).toEqual(["proposal"]);
    expect(
      causalNeighbors("proposal", [
        proposal,
        contradiction,
        synthesis,
      ]).opposing.map((item) => item.id),
    ).toEqual(["against"]);
  });
});

describe("system instruction detection", () => {
  it("recognizes platform markers and only those", () => {
    expect(isSystemInstruction("[agentweave template=software-development phase=execution] Do the thing")).toBe(true);
    expect(isSystemInstruction("Re-prompt:\n\n[agentweave implementation-trigger] Decompose")).toBe(true);
    expect(isSystemInstruction("Please use [agentweave] as the codename in the README")).toBe(true);
    expect(isSystemInstruction("Ship it, but keep the tests green")).toBe(false);
    expect(isSystemInstruction("")).toBe(false);
  });
});

describe("structured content parsing", () => {
  it("surfaces the summary and moves nested insights into details", () => {
    const parsed = parseStructuredContent(
      JSON.stringify({
        schemaVersion: 1,
        summary: "Proceed with the plan.",
        insights: [{ content: "First reason." }, { text: "Second reason." }, { body: "Third reason." }],
      }),
    );
    expect(parsed.summary).toBe("Proceed with the plan.");
    expect(parsed.details).toContain("First reason.");
    expect(parsed.details).toContain("Second reason.");
    expect(parsed.details).toContain("Third reason.");
  });

  it("falls back to the pretty-printed envelope when there are no nested insights", () => {
    const parsed = parseStructuredContent('{"summary":"Only a summary.","confidence":0.9}');
    expect(parsed.summary).toBe("Only a summary.");
    expect(parsed.details).toContain('"confidence": 0.9');
  });

  it("treats prose and broken JSON as prose", () => {
    expect(parseStructuredContent("Just a plain reply.")).toEqual({ summary: "Just a plain reply." });
    expect(parseStructuredContent("{not json")).toEqual({ summary: "{not json" });
    expect(parseStructuredContent('{"insights":[]}')).toEqual({ summary: '{"insights":[]}' });
  });
});

describe("task short labels", () => {
  it("uses the last id segment instead of a mid-word slice", () => {
    expect(taskShortLabel("fad281b1:task-proposal-1")).toBe("task-proposal-1");
    expect(taskShortLabel("proposal-1")).toBe("proposal-1");
    expect(taskShortLabel("ws:12345678-1234-1234-1234-123456789abc")).toBe("…56789abc");
  });
});

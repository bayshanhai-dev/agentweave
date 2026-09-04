import { describe, expect, it } from "vitest";
import {
  causalNeighbors,
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

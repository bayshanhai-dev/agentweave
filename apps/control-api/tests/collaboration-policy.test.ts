import { describe, expect, it } from "vitest";
import type { CollaborationRound, Insight } from "@agentweave/domain";
import { CollaborationPolicy } from "../src/collaboration-policy.js";

const now = Date.parse("2026-09-04T08:00:00Z");
const round = (
  overrides: Partial<CollaborationRound> = {},
): CollaborationRound => ({
  id: "round-1",
  workstreamId: "ws-1",
  topic: "Choose an implementation",
  participantAgentIds: ["pm", "pe", "qa"],
  synthesizerAgentId: "pm",
  maxTurns: 5,
  deadline: "2026-09-04T09:00:00Z",
  completionRule: "synthesizer",
  status: "active",
  insightIds: [],
  createdAt: "2026-09-04T07:00:00Z",
  updatedAt: "2026-09-04T07:00:00Z",
  ...overrides,
});
const insight = (
  id: string,
  kind: Insight["kind"],
  authorAgentId: string,
  extra: Partial<Insight> = {},
): Insight => ({
  id,
  workstreamId: "ws-1",
  kind,
  lifecycle: "accepted",
  authorAgentId,
  content: `${kind} ${id}`,
  confidence: 0.8,
  references: [],
  evidenceIds: [],
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
  ...extra,
});

describe("bounded collaboration policy", () => {
  it("runs proposal, critique, and evidence-linked synthesis", () => {
    const policy = new CollaborationPolicy();
    const proposalA = insight("p1", "proposal", "pm");
    expect(policy.evaluate(round(), [], proposalA, now).next).toBe("proposal");
    const proposalB = insight("p2", "proposal", "pe");
    expect(policy.evaluate(round(), [proposalA], proposalB, now).next).toBe(
      "critique",
    );
    const critique = insight("c1", "critique", "qa", { references: ["p1"] });
    expect(
      policy.evaluate(round(), [proposalA, proposalB], critique, now).next,
    ).toBe("synthesis");
    const synthesis = insight("s1", "synthesis", "pm", {
      references: ["p1", "c1"],
      evidenceIds: ["evidence-1"],
    });
    expect(
      policy.evaluate(
        round(),
        [proposalA, proposalB, critique],
        synthesis,
        now,
      ),
    ).toMatchObject({
      accepted: true,
      next: "stopped",
      stopReason: "synthesis_completed",
      round: { status: "completed" },
    });
  });

  it("stops repeated and over-budget chatter", () => {
    const policy = new CollaborationPolicy();
    const first = insight("p1", "proposal", "pm", { content: "Use an outbox" });
    expect(
      policy.evaluate(
        round(),
        [first],
        insight("p2", "proposal", "pe", { content: "USE an outbox!" }),
        now,
      ).stopReason,
    ).toBe("novelty_exhausted");
    expect(
      policy.evaluate(
        round({ maxTurns: 1 }),
        [first],
        insight("p2", "proposal", "pe"),
        now,
      ).stopReason,
    ).toBe("turn_budget_exhausted");
  });

  it("stops at the deadline", () => {
    expect(
      new CollaborationPolicy().evaluate(
        round({ deadline: "2026-09-04T07:59:59Z" }),
        [],
        insight("p1", "proposal", "pm"),
        now,
      ).stopReason,
    ).toBe("deadline_exceeded");
  });
});

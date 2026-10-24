import { describe, expect, it, vi } from "vitest";
import {
  reconcileGatedLeadDecisionAfterActivation,
  recoverGatedLeadDecisionPayload,
  serializeGatedLeadDecisionPayload,
} from "../src/gated-lead-decision.js";
import { extractStructuredTaskSpecs } from "../src/structured-turn.js";
import { implementationTriggerMarker } from "../src/approval-implementation-trigger.js";

const structuredDecision = {
  schemaVersion: 1 as const,
  summary: "Produce the deliverables for the podcast episode",
  insights: [],
  messages: [],
  tasks: [
    {
      id: "script",
      title: "Write the episode script",
      ownerRole: "writer",
      acceptanceCriteria: ["episode-script.md contains at least 1,500 words"],
      dependencies: [],
    },
    {
      id: "audio",
      title: "Produce the episode audio",
      ownerRole: "producer",
      acceptanceCriteria: ["episode.mp3 is a mastered audio file"],
      dependencies: ["script"],
    },
  ],
};

function fixture() {
  const correlationId = "implementation-trigger-correlation";
  const decisionText = JSON.stringify(structuredDecision);
  const events = [
    {
      id: "round-completed",
      type: "collaboration.round.completed",
      message: "Round completed",
    },
    {
      id: "turn-started",
      type: "turn.started",
      message: "turn started",
      agentId: "showrunner-1",
      correlationId,
    },
    {
      id: "turn-delta-1",
      type: "turn.delta",
      message: decisionText.slice(0, 80),
      agentId: "showrunner-1",
      correlationId,
    },
    {
      id: "turn-delta-2",
      type: "turn.delta",
      message: decisionText.slice(80),
      agentId: "showrunner-1",
      correlationId,
    },
    {
      id: "turn-completed",
      type: "turn.completed",
      message: "turn completed",
      agentId: "showrunner-1",
      correlationId,
    },
  ];
  events.push({
    id: "gated-decision",
    type: "task.gated",
    message: "showrunner → Execution is waiting_for_human",
    agentId: "showrunner-1",
    correlationId,
  });
  const workstream = {
    status: "waiting_for_human",
    tasks: ["proposal-1", "proposal-2", "critique", "synthesis"].map((name) => ({
      title: `[Collaboration:${name.startsWith("proposal") ? "proposal" : name}] ${name}`,
    })),
    messages: [{
      correlationId,
      recipientIds: ["showrunner-1"],
      content: `${implementationTriggerMarker} decompose the synthesis`,
    }],
    events,
  };
  const applyDecision = vi.fn(async (decision: { payload: { structuredResult: typeof structuredDecision } }) => {
    if (workstream.tasks.some((task) => !task.title.startsWith("[Collaboration:"))) return;
    const specs = extractStructuredTaskSpecs(
      decision.payload.structuredResult,
      new Set(["showrunner", "writer", "producer", "reviewer"]),
      "reviewer",
    );
    workstream.tasks.push(...specs.map((spec) => ({ title: spec.title })));
    workstream.events.push({
      id: "decomposition-persisted",
      type: "task.decomposition.persisted",
      message: "Decomposition persisted",
      correlationId,
    });
  });
  const dependencies = {
    applyDecision,
    decisionApplied: () => workstream.events.some(
      (event) =>
        event.type === "task.decomposition.persisted" &&
        event.correlationId === correlationId,
    ),
    recordApplied: vi.fn((decision: { correlationId: string }) => {
      workstream.events.push({
        id: "gated-decision-applied",
        type: "orchestration.gated_decision_applied",
        message: "Held lead decomposition decision applied after activation",
        correlationId: decision.correlationId,
      });
    }),
  };
  return { workstream, dependencies, applyDecision };
}

describe("gated lead decomposition activation", () => {
  it("recovers the live legacy gate, then applies its completed decision exactly once on activation", async () => {
    const { workstream, dependencies, applyDecision } = fixture();

    expect(
      await reconcileGatedLeadDecisionAfterActivation(
        workstream,
        "showrunner-1",
        dependencies,
      ),
    ).toBe(false);
    expect(applyDecision).not.toHaveBeenCalled();

    workstream.status = "active";
    expect(
      await reconcileGatedLeadDecisionAfterActivation(
        workstream,
        "showrunner-1",
        dependencies,
      ),
    ).toBe(true);
    expect(applyDecision).toHaveBeenCalledOnce();
    expect(workstream.tasks.map((task) => task.title)).toEqual([
      "[Collaboration:proposal] proposal-1",
      "[Collaboration:proposal] proposal-2",
      "[Collaboration:critique] critique",
      "[Collaboration:synthesis] synthesis",
      "Write the episode script",
      "Produce the episode audio",
      "Final validation: run the full project suite",
    ]);
    expect(
      workstream.events.some(
        (event) => event.type === "orchestration.gated_decision_applied",
      ),
    ).toBe(true);

    expect(
      await reconcileGatedLeadDecisionAfterActivation(
        workstream,
        "showrunner-1",
        dependencies,
      ),
    ).toBe(false);
    expect(applyDecision).toHaveBeenCalledOnce();
    expect(workstream.tasks).toHaveLength(7);
  });

  it("reads a decision embedded directly in a new gated event", async () => {
    const { workstream, dependencies, applyDecision } = fixture();
    const gated = workstream.events.find((event) => event.type === "task.gated")!;
    const held = recoverGatedLeadDecisionPayload(workstream.events, {
      agentId: "showrunner-1",
      correlationId: gated.correlationId,
      structuredResult: structuredDecision,
    });
    if (!held) throw new Error("fixture decision was not recovered");
    gated.output = serializeGatedLeadDecisionPayload(held);
    workstream.events = workstream.events.filter(
      (event) => !["turn.started", "turn.delta", "turn.completed"].includes(event.type),
    );
    workstream.status = "active";

    expect(
      await reconcileGatedLeadDecisionAfterActivation(
        workstream,
        "showrunner-1",
        dependencies,
      ),
    ).toBe(true);
    expect(applyDecision).toHaveBeenCalledOnce();
  });

  it("leaves the normal non-gated decomposition path untouched", async () => {
    const { workstream, dependencies, applyDecision } = fixture();
    workstream.status = "active";
    workstream.events = workstream.events.filter(
      (event) => event.type !== "task.gated",
    );

    expect(
      await reconcileGatedLeadDecisionAfterActivation(
        workstream,
        "showrunner-1",
        dependencies,
      ),
    ).toBe(false);
    expect(applyDecision).not.toHaveBeenCalled();
    expect(workstream.tasks).toHaveLength(4);
  });
});

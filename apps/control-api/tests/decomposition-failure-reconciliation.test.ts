import { describe, expect, it, vi } from "vitest";
import type { CollaborationRound, Insight } from "@agentweave/domain";
import {
  parkTerminalDecompositionFailure,
  reconcileDecompositionFailureAfterActivation,
} from "../src/decomposition-failure-reconciliation.js";
import { implementationTriggerMarker } from "../src/approval-implementation-trigger.js";

const now = "2026-10-24T06:00:00.000Z";
const completedRound: CollaborationRound = {
  id: "round-1",
  workstreamId: "ws-1",
  topic: "Produce the podcast",
  participantAgentIds: ["showrunner-1", "producer-1"],
  synthesizerAgentId: "showrunner-1",
  maxTurns: 3,
  deadline: now,
  completionRule: "synthesizer",
  status: "completed",
  insightIds: ["synthesis-1"],
  createdAt: now,
  updatedAt: now,
};
const synthesis: Insight = {
  id: "synthesis-1",
  workstreamId: "ws-1",
  kind: "synthesis",
  lifecycle: "accepted",
  authorAgentId: "showrunner-1",
  content: "Create a scripted and mastered podcast episode.",
  confidence: 0.9,
  references: [],
  evidenceIds: [],
  createdAt: now,
  updatedAt: now,
};

function fixture() {
  const workstream = {
    id: "ws-1",
    goal: "Produce a complete podcast episode",
    status: "active",
    agents: [
      { id: "showrunner-1", role: "showrunner" },
      { id: "producer-1", role: "producer" },
      { id: "reviewer-1", role: "reviewer" },
    ],
    tasks: [
      { title: "[Collaboration:proposal] Producer proposal" },
      { title: "[Collaboration:synthesis] Showrunner synthesis" },
    ],
    messages: [],
    events: [
      {
        id: "round-completed",
        type: "collaboration.round.completed",
        message: "Round completed",
        occurredAt: now,
      },
    ],
  };
  const failureMessages: string[] = [];
  const dispatchTrigger = vi.fn(async () => ({ deliveryStatus: "delivered" }));
  const redriveDependencies = {
    leadRole: "showrunner",
    listRounds: vi.fn(async () => [completedRound]),
    listInsights: vi.fn(async () => [synthesis]),
    dispatchTrigger,
    emit: vi.fn(
      (type: "orchestration.decomposition_redriven", message: string) => {
        workstream.events.push({
          id: `redrive-${workstream.events.length}`,
          type,
          message,
          occurredAt: now,
        });
      },
    ),
  };
  const park = (detail: string) =>
    parkTerminalDecompositionFailure(workstream, 2, detail, {
      createFailureMessage: vi.fn(async (content: string) => {
        failureMessages.push(content);
      }),
      emitFailure: (message: string) =>
        workstream.events.push({
          id: `failure-${workstream.events.length}`,
          type: "orchestration.decomposition_failed",
          message,
          occurredAt: now,
        }),
      persistWorkstreamStatus: vi.fn(async () => undefined),
      setLeadIdle: vi.fn(async () => undefined),
    });
  return {
    workstream,
    failureMessages,
    dispatchTrigger,
    redriveDependencies,
    park,
  };
}

describe("decomposition failure activation reconciliation", () => {
  it("redrives exactly once on activation and accepts a successful decomposition", async () => {
    const state = fixture();
    await state.park("Decomposition must contain between 1 and 12 tasks");
    expect(state.workstream.status).toBe("waiting_for_human");

    state.workstream.status = "active";
    expect(
      await reconcileDecompositionFailureAfterActivation(
        state.workstream,
        state.redriveDependencies,
      ),
    ).toBe(true);
    expect(
      await reconcileDecompositionFailureAfterActivation(
        state.workstream,
        state.redriveDependencies,
      ),
    ).toBe(false);
    expect(state.dispatchTrigger).toHaveBeenCalledOnce();
    expect(state.dispatchTrigger.mock.calls[0]?.[0]).toMatchObject({
      leadAgentId: "showrunner-1",
      causationId: "failure-1",
    });
    expect(state.redriveDependencies.emit).toHaveBeenCalledWith(
      "orchestration.decomposition_redriven",
      expect.stringContaining(
        "Decomposition must contain between 1 and 12 tasks",
      ),
    );

    state.workstream.tasks.push({ title: "Write the episode script" });
    state.workstream.events.push({
      id: "persisted",
      type: "task.decomposition.persisted",
      message: "Implementation tasks created",
      occurredAt: now,
    });
    expect(
      await reconcileDecompositionFailureAfterActivation(
        state.workstream,
        state.redriveDependencies,
      ),
    ).toBe(false);
    expect(state.dispatchTrigger).toHaveBeenCalledOnce();
  });

  it("parks again with the reason when the re-triggered decomposition fails terminally", async () => {
    const state = fixture();
    await state.park("Initial invalid task list");
    state.workstream.status = "active";
    expect(
      await reconcileDecompositionFailureAfterActivation(
        state.workstream,
        state.redriveDependencies,
      ),
    ).toBe(true);

    await state.park("Repeated failure: acceptance criteria were empty");
    expect(state.workstream.status).toBe("waiting_for_human");
    expect(state.failureMessages.at(-1)).toContain(
      "Repeated failure: acceptance criteria were empty",
    );
    expect(state.workstream.events.at(-1)).toMatchObject({
      type: "orchestration.decomposition_failed",
      message: expect.stringContaining(
        "Repeated failure: acceptance criteria were empty",
      ),
    });
    expect(state.dispatchTrigger).toHaveBeenCalledOnce();
  });

  it("does not duplicate a decomposition trigger that is already in flight", async () => {
    const state = fixture();
    await state.park("Initial invalid task list");
    state.workstream.status = "active";
    state.workstream.messages.push({
      content: `${implementationTriggerMarker} fresh retry`,
      createdAt: now,
      deliveryStatus: "delivered",
      causationId: "failure-1",
    });

    expect(
      await reconcileDecompositionFailureAfterActivation(
        state.workstream,
        state.redriveDependencies,
      ),
    ).toBe(false);
    expect(state.dispatchTrigger).not.toHaveBeenCalled();
  });
});

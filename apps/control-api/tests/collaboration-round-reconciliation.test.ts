import { describe, expect, it, vi } from "vitest";
import type { Insight } from "@agentweave/domain";
import { CollaborationPolicy } from "../src/collaboration-policy.js";
import {
  createCollaborationRound,
  dispatchForDecision,
} from "../src/collaboration-runtime.js";
import {
  parkFailedCollaborationTurn,
  reconcileCollaborationRoundAfterActivation,
} from "../src/collaboration-round-reconciliation.js";

const agents = [
  { id: "pm-1", role: "pm", authority: "lead" as const },
  { id: "backend-1", role: "backend", authority: "executor" as const },
  { id: "frontend-1", role: "frontend", authority: "executor" as const },
  { id: "qa-1", role: "qa", authority: "reviewer" as const },
];

const insight = (
  id: string,
  kind: Insight["kind"],
  authorAgentId: string,
  references: string[] = [],
): Insight => ({
  id,
  workstreamId: "ws-1",
  kind,
  lifecycle: "accepted",
  authorAgentId,
  content: `${kind} ${id} contains a distinct, substantive approach`,
  confidence: 0.8,
  references,
  evidenceIds: kind === "synthesis" ? ["1"] : [],
  createdAt: "2026-10-24T05:00:00.000Z",
  updatedAt: "2026-10-24T05:00:00.000Z",
});

function failedProposalFixture() {
  const { round, dispatches } = createCollaborationRound(
    "ws-1",
    "Ship a reliable collaboration workflow",
    agents,
    new Date("2026-10-24T05:00:00.000Z"),
  );
  const survivingProposal = insight(
    "proposal-from-frontend",
    "proposal",
    "frontend-1",
  );
  round.insightIds = [survivingProposal.id];
  const tasks = dispatches.map((dispatch) => ({
    id: `${round.id}:task:${dispatch.key}`,
    title: `[Collaboration:${dispatch.stage}] ${dispatch.title}`,
    status: dispatch.agentId === "backend-1" ? "failed" : "done",
    ownerAgentId: dispatch.agentId,
    updatedAt: "2026-10-24T05:05:00.000Z",
  }));
  const workstream = {
    id: "ws-1",
    status: "waiting_for_human",
    agents,
    tasks,
    messages: dispatches.map((dispatch) => ({
      taskId: `${round.id}:task:${dispatch.key}`,
      deliveryStatus: "delivered",
      createdAt: "2026-10-24T05:00:00.000Z",
    })),
    events: [
      {
        type: "task.failed",
        message:
          "[Collaboration:proposal] Independent proposal from backend → fetch failed",
        taskId: `${round.id}:task:proposal-1`,
        occurredAt: "2026-10-24T05:05:00.000Z",
      },
      {
        type: "workstream.waiting_for_human",
        message: "Provider execution failed; Human decision required",
        occurredAt: "2026-10-24T05:05:00.001Z",
      },
    ],
  };
  const dispatchTurn = vi.fn(async ({ task }: { task: { id: string } }) => {
    const correlationId = `redrive-${workstream.messages.length}`;
    workstream.messages.push({
      taskId: task.id,
      deliveryStatus: "delivered",
      createdAt: "2026-10-24T05:10:15.000Z",
    });
    return { deliveryStatus: "delivered", correlationId };
  });
  const emit = vi.fn((type, message, details) => {
    workstream.events.push({
      type,
      message,
      taskId: details.taskId,
      occurredAt: "2026-10-24T05:10:15.001Z",
    });
  });
  const dependencies = {
    listRounds: vi.fn(async () => [round]),
    listInsights: vi.fn(async () => [survivingProposal]),
    hasExecutionClaim: vi.fn(async () => false),
    persistTask: vi.fn(async () => undefined),
    dispatchTurn,
    emit,
    now: () => new Date("2026-10-24T05:10:15.000Z"),
  };
  return {
    round,
    survivingProposal,
    workstream,
    dependencies,
    dispatchTurn,
    emit,
  };
}

describe("collaboration round activation reconciliation", () => {
  it("re-dispatches the failed proposal exactly once after resume and its success completes the round normally", async () => {
    const fixture = failedProposalFixture();
    expect(fixture.workstream.events.at(-1)?.message).toBe(
      "Provider execution failed; Human decision required",
    );

    fixture.workstream.status = "active";
    expect(
      await reconcileCollaborationRoundAfterActivation(
        fixture.workstream,
        fixture.dependencies,
      ),
    ).toEqual([`${fixture.round.id}:task:proposal-1`]);
    expect(fixture.dispatchTurn).toHaveBeenCalledOnce();
    expect(fixture.dispatchTurn.mock.calls[0]?.[0].dispatch).toMatchObject({
      key: "proposal-1",
      stage: "proposal",
      agentId: "backend-1",
    });
    expect(fixture.emit).toHaveBeenCalledWith(
      "collaboration.turn.redriven",
      expect.stringContaining("proposal turn re-dispatched after failure"),
      expect.objectContaining({
        taskId: `${fixture.round.id}:task:proposal-1`,
        correlationId: "redrive-2",
      }),
    );

    // An activation reconciliation while that fresh handoff is in flight is a no-op.
    expect(
      await reconcileCollaborationRoundAfterActivation(
        fixture.workstream,
        fixture.dependencies,
      ),
    ).toEqual([]);
    expect(fixture.dispatchTurn).toHaveBeenCalledOnce();

    const policy = new CollaborationPolicy();
    const recovered = insight("proposal-from-backend", "proposal", "backend-1");
    const proposals = [fixture.survivingProposal, recovered];
    const afterProposal = policy.evaluate(
      fixture.round,
      [fixture.survivingProposal],
      recovered,
      Date.parse("2026-10-24T05:11:00.000Z"),
    );
    expect(dispatchForDecision(afterProposal, proposals, agents)?.stage).toBe(
      "critique",
    );

    const critique = insight("critique", "critique", "qa-1", [recovered.id]);
    const afterCritique = policy.evaluate(
      afterProposal.round,
      proposals,
      critique,
      Date.parse("2026-10-24T05:12:00.000Z"),
    );
    expect(
      dispatchForDecision(afterCritique, [...proposals, critique], agents)
        ?.stage,
    ).toBe("synthesis");

    const synthesis = insight("synthesis", "synthesis", "pm-1", [
      recovered.id,
      critique.id,
    ]);
    const completed = policy.evaluate(
      afterCritique.round,
      [...proposals, critique],
      synthesis,
      Date.parse("2026-10-24T05:13:00.000Z"),
    );
    expect(completed.round.status).toBe("completed");
    expect(completed.stopReason).toBe("synthesis_completed");
  });

  it("leaves a healthy in-flight round untouched", async () => {
    const fixture = failedProposalFixture();
    fixture.workstream.status = "active";
    fixture.workstream.tasks[0]!.status = "running";
    fixture.workstream.events = [];
    fixture.dependencies.hasExecutionClaim.mockResolvedValue(true);

    expect(
      await reconcileCollaborationRoundAfterActivation(
        fixture.workstream,
        fixture.dependencies,
      ),
    ).toEqual([]);
    expect(fixture.dispatchTurn).not.toHaveBeenCalled();
    expect(fixture.emit).not.toHaveBeenCalled();
  });

  it("re-parks a re-dispatched turn that fails again without silently looping", async () => {
    const fixture = failedProposalFixture();
    fixture.workstream.status = "active";
    await reconcileCollaborationRoundAfterActivation(
      fixture.workstream,
      fixture.dependencies,
    );
    const task = fixture.workstream.tasks[0]!;
    const failureEvents: Array<{ type: string; message: string }> = [];

    expect(
      await parkFailedCollaborationTurn(
        fixture.workstream,
        task,
        "fetch failed again",
        {
          persistTask: vi.fn(async () => undefined),
          setAgentIdle: vi.fn(async () => undefined),
          recordFailure: (reason) =>
            failureEvents.push({
              type: "task.failed",
              message: `${task.title} → ${reason}`,
            }),
          recordWaiting: () =>
            failureEvents.push({
              type: "workstream.waiting_for_human",
              message: "Provider execution failed; Human decision required",
            }),
          persistWorkstreamStatus: vi.fn(async () => undefined),
          now: () => new Date("2026-10-24T05:15:00.000Z"),
        },
      ),
    ).toBe(true);
    expect(task.status).toBe("failed");
    expect(fixture.workstream.status).toBe("waiting_for_human");
    expect(failureEvents).toEqual([
      {
        type: "task.failed",
        message: `${task.title} → fetch failed again`,
      },
      {
        type: "workstream.waiting_for_human",
        message: "Provider execution failed; Human decision required",
      },
    ]);

    expect(
      await reconcileCollaborationRoundAfterActivation(
        fixture.workstream,
        fixture.dependencies,
      ),
    ).toEqual([]);
    expect(fixture.dispatchTurn).toHaveBeenCalledOnce();
  });

  it("re-dispatches a gated missing turn with its original collaboration contract", async () => {
    const fixture = failedProposalFixture();
    fixture.workstream.status = "active";
    fixture.workstream.tasks[0]!.status = "assigned";
    fixture.workstream.events[0] = {
      type: "task.gated",
      message: "proposal held by Human gate",
      taskId: `${fixture.round.id}:task:proposal-1`,
      occurredAt: "2026-10-24T05:05:00.000Z",
    };

    expect(
      await reconcileCollaborationRoundAfterActivation(
        fixture.workstream,
        fixture.dependencies,
      ),
    ).toEqual([`${fixture.round.id}:task:proposal-1`]);
    expect(fixture.dispatchTurn.mock.calls[0]?.[0].dispatch.prompt).toContain(
      "stage=proposal",
    );
    expect(fixture.emit).toHaveBeenCalledWith(
      "collaboration.turn.redriven",
      expect.stringContaining("proposal turn re-dispatched after Human gate"),
      expect.any(Object),
    );
  });
});

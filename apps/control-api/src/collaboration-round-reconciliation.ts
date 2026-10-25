import type { CollaborationRound, Insight } from "@agentweave/domain";
import {
  collaborationStage,
  expectedCollaborationDispatches,
  type CollaborationAgent,
  type CollaborationDispatch,
} from "./collaboration-runtime.js";

type CollaborationTask = {
  id: string;
  title: string;
  status: string;
  ownerAgentId?: string;
  createdByAgentId?: string;
  updatedAt: string;
};

type CollaborationMessage = {
  taskId?: string;
  deliveryStatus: string;
  createdAt: string;
};

type CollaborationEvent = {
  type: string;
  message: string;
  taskId?: string;
  occurredAt: string;
};

type CollaborationWorkstream = {
  id: string;
  status: string;
  agents: CollaborationAgent[];
  tasks: CollaborationTask[];
  messages: CollaborationMessage[];
  events: CollaborationEvent[];
};

type RedriveDependencies = {
  listRounds: (workstreamId: string) => Promise<CollaborationRound[]>;
  listInsights: (workstreamId: string) => Promise<Insight[]>;
  hasExecutionClaim: (
    taskId: string,
    startedAfter?: string,
  ) => Promise<boolean>;
  persistTask: (task: CollaborationTask) => Promise<void>;
  dispatchTurn: (input: {
    roundId: string;
    dispatch: CollaborationDispatch;
    task: CollaborationTask;
    senderId: string;
  }) => Promise<{ deliveryStatus?: string; correlationId?: string }>;
  emit: (
    type: "collaboration.turn.redriven",
    message: string,
    details: {
      role: string;
      agentId: string;
      taskId: string;
      correlationId?: string;
    },
  ) => void;
  now?: () => Date;
};

type CollaborationFailureDependencies = {
  persistTask: (task: CollaborationTask) => Promise<void>;
  setAgentIdle: () => Promise<void>;
  recordFailure: (reason: string) => void;
  recordWaiting: () => void;
  persistWorkstreamStatus: () => Promise<void>;
  now?: () => Date;
};

const openDeliveryStatuses = new Set(["pending", "delivered"]);
const boundaryEventTypes = new Set([
  "task.failed",
  "task.gated",
  "collaboration.turn.redriven",
  "task.completed",
]);
const interruptionEventTypes = new Set([
  "workstream.waiting_for_human",
  "workstream.paused",
  "workstream.pause",
]);
export const staleCollaborationAssignmentMs = 120_000;

function latestTaskBoundary(
  workstream: CollaborationWorkstream,
  taskId: string,
): CollaborationEvent | undefined {
  return [...workstream.events]
    .reverse()
    .find(
      (event) => event.taskId === taskId && boundaryEventTypes.has(event.type),
    );
}

function latestInterruption(
  workstream: CollaborationWorkstream,
): CollaborationEvent | undefined {
  return [...workstream.events]
    .reverse()
    .find((event) => interruptionEventTypes.has(event.type));
}

/**
 * Re-drives interrupted source turns that are still missing from the current
 * active round. Fresh handoffs make Worker execution reclaimable while the
 * stable collaboration task continues to identify the logical turn.
 */
export async function reconcileCollaborationRoundAfterActivation(
  workstream: CollaborationWorkstream,
  dependencies: RedriveDependencies,
): Promise<string[]> {
  if (workstream.status !== "active") return [];
  const rounds = await dependencies.listRounds(workstream.id);
  const round = rounds.at(-1);
  if (!round || round.status !== "active") return [];

  const insights = await dependencies.listInsights(workstream.id);
  const expected = expectedCollaborationDispatches(
    round,
    insights,
    workstream.agents,
  );
  const redrivenTaskIds: string[] = [];
  const now = dependencies.now?.() ?? new Date();
  const interruption = latestInterruption(workstream);

  for (const dispatch of expected) {
    const taskId = `${round.id}:task:${dispatch.key}`;
    const task = workstream.tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.ownerAgentId !== dispatch.agentId) continue;

    const boundary = latestTaskBoundary(workstream, task.id);
    const failed = task.status === "failed";
    const gated = task.status === "assigned" && boundary?.type === "task.gated";
    const updatedAt = Date.parse(task.updatedAt);
    const staleAssigned =
      task.status === "assigned" &&
      Number.isFinite(updatedAt) &&
      now.getTime() - updatedAt >= staleCollaborationAssignmentMs;
    if (!failed && !gated && !staleAssigned) continue;

    const taskInterruption =
      boundary?.type === "task.failed" || boundary?.type === "task.gated"
        ? boundary.occurredAt
        : undefined;
    const interruptedAt =
      taskInterruption ?? interruption?.occurredAt ?? task.updatedAt;
    if (
      workstream.messages.some(
        (message) =>
          message.taskId === task.id &&
          openDeliveryStatuses.has(message.deliveryStatus) &&
          Date.parse(message.createdAt) > Date.parse(interruptedAt),
      ) ||
      (await dependencies.hasExecutionClaim(task.id, interruptedAt))
    )
      continue;

    const previousStatus = task.status;
    task.status = "assigned";
    task.updatedAt = now.toISOString();
    await dependencies.persistTask(task);
    const handoff = await dependencies.dispatchTurn({
      roundId: round.id,
      dispatch,
      task,
      senderId: task.createdByAgentId ?? "human",
    });
    if (handoff.deliveryStatus !== "delivered") {
      task.status = previousStatus;
      task.updatedAt = now.toISOString();
      await dependencies.persistTask(task);
      continue;
    }

    redrivenTaskIds.push(task.id);
    const interruptionReason = failed
      ? "failure"
      : gated
        ? "Human gate"
        : "stale unclaimed assignment";
    const detail = boundary?.message.trim();
    dependencies.emit(
      "collaboration.turn.redriven",
      `${dispatch.stage} turn re-dispatched after ${interruptionReason}${detail ? `: ${detail}` : ""}`,
      {
        role: dispatch.role,
        agentId: dispatch.agentId,
        taskId: task.id,
        ...(handoff.correlationId
          ? { correlationId: handoff.correlationId }
          : {}),
      },
    );
  }

  return redrivenTaskIds;
}

/** Keeps a repeated collaboration provider failure loud and explicitly gated. */
export async function parkFailedCollaborationTurn(
  workstream: Pick<CollaborationWorkstream, "status">,
  task: CollaborationTask,
  reason: string,
  dependencies: CollaborationFailureDependencies,
): Promise<boolean> {
  if (!collaborationStage(task.title)) return false;
  task.status = "failed";
  task.updatedAt = (dependencies.now?.() ?? new Date()).toISOString();
  await dependencies.persistTask(task);
  await dependencies.setAgentIdle();
  dependencies.recordFailure(reason);
  workstream.status = "waiting_for_human";
  dependencies.recordWaiting();
  await dependencies.persistWorkstreamStatus();
  return true;
}

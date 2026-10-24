import type { CollaborationRound, Insight } from "@agentweave/domain";
import {
  implementationTriggerContent,
  implementationTriggerMarker,
} from "./approval-implementation-trigger.js";
import { collaborationStage } from "./collaboration-runtime.js";

type DecompositionEvent = {
  id?: string;
  type: string;
  message: string;
  occurredAt: string;
};

type DecompositionWorkstream = {
  id: string;
  goal: string;
  status: string;
  agents: Array<{ id: string; role: string }>;
  tasks: Array<{ title: string }>;
  messages: Array<{
    content: string;
    createdAt: string;
    deliveryStatus: string;
    causationId?: string;
  }>;
  events: DecompositionEvent[];
};

type RedriveDependencies = {
  leadRole: string;
  listRounds: (workstreamId: string) => Promise<CollaborationRound[]>;
  listInsights: (workstreamId: string) => Promise<Insight[]>;
  dispatchTrigger: (input: {
    leadAgentId: string;
    content: string;
    causationId?: string;
  }) => Promise<{ deliveryStatus?: string }>;
  emit: (type: "orchestration.decomposition_redriven", message: string) => void;
};

type FailureDependencies = {
  createFailureMessage: (content: string) => Promise<unknown>;
  emitFailure: (message: string) => void;
  persistWorkstreamStatus: () => Promise<void>;
  setLeadIdle: () => Promise<void>;
};

const decompositionOutcomeTypes = new Set([
  "orchestration.decomposition_failed",
  "task.decomposition.persisted",
]);
const inFlightEventTypes = new Set([
  "orchestration.decomposition_redriven",
  "orchestration.decomposition_reprompted",
  "orchestration.implementation_triggered",
]);

/** Re-dispatches one fresh implementation trigger after the latest terminal decomposition failure. */
export async function reconcileDecompositionFailureAfterActivation(
  workstream: DecompositionWorkstream,
  dependencies: RedriveDependencies,
): Promise<boolean> {
  if (
    workstream.status !== "active" ||
    workstream.tasks.some((task) => !collaborationStage(task.title))
  )
    return false;

  const rounds = await dependencies.listRounds(workstream.id);
  if (rounds.at(-1)?.status !== "completed") return false;

  const failureIndex = workstream.events.findLastIndex((event) =>
    decompositionOutcomeTypes.has(event.type),
  );
  const failure = workstream.events[failureIndex];
  if (!failure || failure.type !== "orchestration.decomposition_failed")
    return false;
  if (
    workstream.events
      .slice(failureIndex + 1)
      .some((event) => inFlightEventTypes.has(event.type))
  )
    return false;
  if (
    workstream.messages.some(
      (message) =>
        message.content.includes(implementationTriggerMarker) &&
        ["pending", "delivered"].includes(message.deliveryStatus) &&
        (message.causationId === failure.id ||
          Date.parse(message.createdAt) > Date.parse(failure.occurredAt)),
    )
  )
    return false;

  const lead = workstream.agents.find(
    (agent) => agent.role === dependencies.leadRole,
  );
  if (!lead) return false;
  const insights = await dependencies.listInsights(workstream.id);
  const synthesis =
    [...insights].reverse().find((insight) => insight.kind === "synthesis") ??
    insights.at(-1);
  const trigger = await dependencies.dispatchTrigger({
    leadAgentId: lead.id,
    content: implementationTriggerContent(
      workstream.goal,
      synthesis?.content,
      workstream.agents.map((agent) => agent.role),
    ),
    ...(failure.id ? { causationId: failure.id } : {}),
  });
  if (trigger.deliveryStatus !== "delivered") return false;

  dependencies.emit(
    "orchestration.decomposition_redriven",
    `Implementation decomposition re-triggered after terminal failure: ${failure.message}`,
  );
  return true;
}

/** Keeps every terminal decomposition failure visible and parked for Human action. */
export async function parkTerminalDecompositionFailure(
  workstream: Pick<DecompositionWorkstream, "status">,
  retries: number,
  detail: string,
  dependencies: FailureDependencies,
): Promise<void> {
  const content = `Implementation decomposition failed after ${retries} retries. ${detail}`;
  await dependencies.createFailureMessage(content);
  workstream.status = "waiting_for_human";
  dependencies.emitFailure(content.slice(0, 600));
  await dependencies.persistWorkstreamStatus();
  await dependencies.setLeadIdle();
}

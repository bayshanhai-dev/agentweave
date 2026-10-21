import type { CollaborationRound } from "@agentweave/domain";
import { collaborationStage } from "./collaboration-runtime.js";

export const implementationTriggerMarker = "[agentweave implementation-trigger]";
export const implementationTriggerInstructionSeparator =
  "\n\nDecompose this into concrete implementation tasks.";

export const implementationTriggerInstruction = (_workstreamId: string): string =>
  "Decompose this into concrete implementation tasks and return them as your reply — the platform creates and assigns the tasks from your reply automatically. Begin your reply with [READY_FOR_DECOMPOSITION], then one line per task in exactly this format: - [role] Task title (role is one of: backend, frontend, pe, qa, devops). Do NOT call any API or URL, do NOT use tools to submit decisions, and do not write the code yourself — delegate to the execution roles.";

export function shouldDispatchMessage(senderId: string, content: string): boolean {
  return senderId === "human" || !content.includes(implementationTriggerMarker);
}

export function implementationTriggerExists(input: {
  messages: Array<{ senderId: string; recipientIds: string[]; content: string }>;
  tasks: Array<{ title: string }>;
  leadAgentId: string;
}): boolean {
  return (
    !input.tasks.some((task) => !collaborationStage(task.title)) &&
    input.messages.some(
      (message) =>
        message.senderId === "human" &&
        message.recipientIds.includes(input.leadAgentId) &&
        message.content.includes(implementationTriggerMarker),
    )
  );
}

export function isImplementationTriggerResult(input: {
  messages: Array<{ correlationId: string; content: string; recipientIds: string[] }>;
  tasks: Array<{ title: string }>;
  senderId: string;
  senderRole: string;
  leadRole: string;
  correlationId?: string;
}): boolean {
  return (
    input.senderRole === input.leadRole &&
    input.correlationId !== undefined &&
    !input.tasks.some((task) => !collaborationStage(task.title)) &&
    input.messages.some(
      (message) =>
        message.correlationId === input.correlationId &&
        message.content.includes(implementationTriggerMarker) &&
        message.recipientIds.includes(input.senderId),
    )
  );
}

type TriggerMessage = {
  id: string;
  senderId: string;
  recipientIds: string[];
  messageType: string;
  content: string;
  createdAt: string;
  causationId?: string;
};

type ApprovalWorkstream = {
  id: string;
  tasks: Array<{ title: string }>;
  messages: TriggerMessage[];
  events: Array<{ type: string; occurredAt: string }>;
};

type TriggerDependencies = {
  listRounds: (workstreamId: string) => Promise<CollaborationRound[]>;
  createMessage: (
    senderId: string,
    recipientIds: string[],
    content: string,
    messageType: string,
    causationId: string,
  ) => Promise<unknown>;
  emit: (type: string, message: string, role?: string) => void;
};

/** Recover the PM implementation prompt that a waiting workstream caused the worker to ACK-skip. */
export async function republishImplementationTriggerAfterResume(
  workstream: ApprovalWorkstream,
  dependencies: TriggerDependencies,
): Promise<boolean> {
  if (workstream.tasks.some((task) => !collaborationStage(task.title))) return false;

  const rounds = await dependencies.listRounds(workstream.id);
  if (rounds.at(-1)?.status !== "completed") return false;

  const triggers = workstream.messages.filter((message) =>
    message.content.includes(implementationTriggerMarker),
  );
  const latestTrigger = triggers.at(-1);
  if (!latestTrigger) return false;

  const copies = triggers.filter(
    (message) =>
      message.causationId !== undefined &&
      triggers.some((candidate) => candidate.id === message.causationId),
  );
  if (copies.length > 0) {
    const latestCopy = copies.reduce((latest, copy) =>
      copy.createdAt > latest.createdAt ? copy : latest,
    );
    if (
      !workstream.events.some(
        (event) => event.type === "task.failed" && event.occurredAt > latestCopy.createdAt,
      )
    )
      return false;
  }

  const separatorIndex = latestTrigger.content.indexOf(implementationTriggerInstructionSeparator);
  const content =
    separatorIndex === -1
      ? latestTrigger.content
      : latestTrigger.content.slice(0, separatorIndex) +
        implementationTriggerInstructionSeparator +
        implementationTriggerInstruction(workstream.id).slice(
          "Decompose this into concrete implementation tasks.".length,
        );

  const created = await dependencies.createMessage(
    latestTrigger.senderId,
    latestTrigger.recipientIds,
    content,
    latestTrigger.messageType,
    latestTrigger.id,
  );
  if (
    typeof created === "object" &&
    created !== null &&
    "deliveryStatus" in created &&
    created.deliveryStatus !== "delivered"
  ) return false;
  dependencies.emit(
    "orchestration.implementation_triggered",
    "PM prompted to decompose synthesis into implementation tasks",
    "human",
  );
  return true;
}

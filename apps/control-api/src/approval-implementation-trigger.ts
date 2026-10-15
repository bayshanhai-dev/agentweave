import type { CollaborationRound } from "@agentweave/domain";
import { collaborationStage } from "./collaboration-runtime.js";

export const implementationTriggerMarker = "[agentweave implementation-trigger]";

type TriggerMessage = {
  id: string;
  senderId: string;
  recipientIds: string[];
  messageType: string;
  content: string;
  causationId?: string;
};

type ApprovalWorkstream = {
  id: string;
  tasks: Array<{ title: string }>;
  messages: TriggerMessage[];
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
  const original = triggers.at(-1);
  if (!original) return false;

  // A copied trigger points back to the skipped message. This is a durable marker
  // that prevents another resume from publishing a third copy before tasks exist.
  if (
    triggers.some(
      (message) =>
        message.causationId !== undefined &&
        triggers.some((candidate) => candidate.id === message.causationId),
    )
  )
    return false;

  await dependencies.createMessage(
    original.senderId,
    original.recipientIds,
    original.content,
    original.messageType,
    original.id,
  );
  dependencies.emit(
    "orchestration.implementation_triggered",
    "PM prompted to decompose synthesis into implementation tasks",
    "human",
  );
  return true;
}

import type { CollaborationRound } from "@agentweave/domain";
import { collaborationStage } from "./collaboration-runtime.js";

export const implementationTriggerMarker = "[agentweave implementation-trigger]";
export const implementationTriggerInstructionSeparator =
  "\n\nDecompose this into concrete implementation tasks.";

const defaultOwnerRoles = ["backend", "frontend", "pe", "qa", "devops"];

const humanizeKey = (key: string): string =>
  key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());

function renderStructuredValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => `${"  ".repeat(depth)}- ${renderStructuredValue(item, depth + 1)}`).join("\n");
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => {
      const rendered = renderStructuredValue(item, depth + 1);
      if (!rendered) return "";
      return typeof item === "object" && item !== null
        ? `${humanizeKey(key)}:\n${rendered}`
        : `${humanizeKey(key)}: ${rendered}`;
    })
    .filter(Boolean)
    .join("\n");
}

/** Render JSON-shaped synthesis content for a model without centering a raw document dump. */
export function renderImplementationSynthesis(content: unknown): string {
  let value = content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (!trimmed) return "No collaboration synthesis was available.";
    try { value = JSON.parse(trimmed) as unknown; } catch { return trimmed.slice(0, 2000); }
  }
  return (renderStructuredValue(value).trim() || "No collaboration synthesis was available.").slice(0, 2000);
}

export function implementationTriggerInstruction(
  goal: string,
  synthesisContent: unknown,
  ownerRoles: readonly string[] = defaultOwnerRoles,
): string {
  const roles = [...new Set(ownerRoles)].join(", ");
  return `WORKSTREAM GOAL (verbatim):\n${goal}\n\nThe tasks must directly produce the deliverables required by this goal. The collaboration synthesis is guidance and constraints, not itself a deliverable. Meta-tasks that create, rewrite, verify, test, or validate the synthesis document are forbidden.\n\nCollaboration synthesis (guidance only):\n${renderImplementationSynthesis(synthesisContent)}${implementationTriggerInstructionSeparator} and return ONLY one JSON object, with no markdown fences or prose. The object must contain schemaVersion set to 1, a summary string, empty insights and messages arrays, and a tasks array. Each task must contain an id, a non-empty title, an ownerRole that is one of ${roles}, and concrete acceptanceCriteria as a non-empty array. Dependencies are optional: omit dependencies to depend on the immediately preceding task (the first task then has none), use an explicit empty array for no dependencies, or name earlier siblings by 1-based ordinal, id, or title. Every acceptance criterion must name the artifact and checkable properties such as its file path, minimum length, required sections, or language. Provide between 1 and 12 real implementation tasks; the platform appends a final full-suite validation task automatically. The platform creates and assigns the tasks from this structured reply automatically. Do NOT call any API or URL, do NOT use tools to submit decisions, and do not perform the implementation yourself — delegate it to the available execution roles.`;
}

export function implementationTriggerContent(
  goal: string,
  synthesisContent: unknown,
  ownerRoles?: readonly string[],
): string {
  return `${implementationTriggerMarker}\n${implementationTriggerInstruction(goal, synthesisContent, ownerRoles)}`;
}

function synthesisFromTrigger(content: string, separatorIndex: number): string {
  const prefix = content.slice(0, separatorIndex);
  const guidanceHeading = "Collaboration synthesis (guidance only):";
  const legacyHeading = "Here is the agreed synthesis:";
  const heading = prefix.includes(guidanceHeading) ? guidanceHeading : legacyHeading;
  const headingIndex = prefix.indexOf(heading);
  return (headingIndex === -1 ? prefix : prefix.slice(headingIndex + heading.length))
    .replace(implementationTriggerMarker, "")
    .trim();
}

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
  goal: string;
  agents: Array<{ role: string }>;
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
  const latestDecompositionBoundary = [...workstream.events].reverse().find((event) =>
    [
      "orchestration.decomposition_failed",
      "orchestration.decomposition_redriven",
      "task.decomposition.persisted",
    ].includes(event.type),
  );
  if (["orchestration.decomposition_failed", "orchestration.decomposition_redriven"].includes(latestDecompositionBoundary?.type ?? ""))
    return false;

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
      : implementationTriggerContent(
          workstream.goal,
          synthesisFromTrigger(latestTrigger.content, separatorIndex),
          workstream.agents.map((agent) => agent.role),
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

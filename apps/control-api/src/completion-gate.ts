import { isFinalValidationTask } from "./final-validation.js";

type CompletionTask = { id: string; title: string; status: string };
type CompletionMessage = {
  messageType: string;
  recipientIds: string[];
  deliveryStatus: string;
};
type CompletionEvent = { taskId?: string; message: string };
type CompletionWorkstream = {
  status: string;
  tasks: CompletionTask[];
  messages: CompletionMessage[];
  events: CompletionEvent[];
};
type CompletionGateDependencies = {
  createGate: (content: string) => Promise<unknown>;
  persistWaitingForHuman: () => Promise<void>;
  emit: (type: string, message: string, role?: string) => void;
};

const terminalTaskStatuses = new Set(["done", "failed", "cancelled"]);
const openDeliveryStatuses = new Set(["pending", "delivered"]);

function completionSummary(workstream: CompletionWorkstream): string {
  const counts = new Map<string, number>();
  for (const task of workstream.tasks)
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  const validation = [...workstream.tasks]
    .reverse()
    .find(isFinalValidationTask);
  const validationResult = validation
    ? [...workstream.events]
        .reverse()
        .find((event) => event.taskId === validation.id)?.message
    : undefined;
  const taskSummary = [...counts.entries()]
    .map(([status, count]) => `${status}: ${count}`)
    .join(", ");
  return [
    "All durable tasks are terminal. Review the run and choose complete or reject.",
    `Task summary: ${taskSummary}.`,
    "",
    "Final validation reported result (verbatim):",
    validationResult ??
      (validation
        ? "No validation result was reported."
        : "No final validation task was present."),
  ].join("\n");
}

/** Create the held Human completion decision once all durable work is terminal. */
export async function reconcileCompletionGate(
  workstream: CompletionWorkstream,
  dependencies: CompletionGateDependencies,
): Promise<boolean> {
  if (
    workstream.status !== "active" ||
    workstream.tasks.length === 0 ||
    workstream.tasks.some((task) => !terminalTaskStatuses.has(task.status)) ||
    workstream.messages.some(
      (message) =>
        message.messageType === "decision" &&
        message.recipientIds.includes("human") &&
        openDeliveryStatuses.has(message.deliveryStatus),
    )
  )
    return false;

  await dependencies.createGate(completionSummary(workstream));
  workstream.status = "waiting_for_human";
  await dependencies.persistWaitingForHuman();
  dependencies.emit(
    "workstream.completion_proposed",
    "All durable tasks are terminal; Human completion decision required",
  );
  dependencies.emit(
    "workstream.waiting_for_human",
    "Human approval required before completion",
  );
  return true;
}

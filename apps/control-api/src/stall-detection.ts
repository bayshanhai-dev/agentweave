type StallTask = { id: string; status: string; ownerAgentId?: string };
type StallMessage = { taskId?: string; deliveryStatus: string };
type StallEvent = { id?: string; type: string; occurredAt: string };
type StallWorkstream = {
  status: string;
  tasks: StallTask[];
  messages: StallMessage[];
  events: StallEvent[];
};

export type WorkstreamStallDecision = {
  episodeKey: string;
  message: string;
  taskCounts: Record<string, number>;
  ownerlessTasks: number;
  assignedButUndispatchedTasks: number;
};

const terminalTaskStatuses = new Set(["done", "failed", "cancelled"]);
const openDeliveryStatuses = new Set(["pending", "delivered"]);
export const workstreamStallQuietMs = 10 * 60_000;

/** Pure stall-episode decision used by the periodic reconciliation sweep. */
export function detectWorkstreamStall(
  workstream: StallWorkstream,
  lastEmittedEpisodeKey: string | undefined,
  now = Date.now(),
  quietMs = workstreamStallQuietMs,
): WorkstreamStallDecision | undefined {
  if (workstream.status !== "active") return undefined;
  const nonTerminalTasks = workstream.tasks.filter(
    (task) => !terminalTaskStatuses.has(task.status),
  );
  if (!nonTerminalTasks.length) return undefined;

  // A stall signal is diagnostic, not workflow activity. Excluding it keeps
  // the signal from immediately creating a second stall episode by itself.
  const latestEvent = workstream.events
    .filter((event) => event.type !== "workstream.stalled")
    .reduce<StallEvent | undefined>((latest, event) => {
      if (!latest) return event;
      return Date.parse(event.occurredAt) > Date.parse(latest.occurredAt)
        ? event
        : latest;
    }, undefined);
  if (!latestEvent) return undefined;
  const latestAt = Date.parse(latestEvent.occurredAt);
  if (!Number.isFinite(latestAt) || now - latestAt <= quietMs) return undefined;
  const episodeKey = latestEvent.id ?? latestEvent.occurredAt;
  if (episodeKey === lastEmittedEpisodeKey) return undefined;

  const taskCounts = nonTerminalTasks.reduce<Record<string, number>>(
    (counts, task) => {
      counts[task.status] = (counts[task.status] ?? 0) + 1;
      return counts;
    },
    {},
  );
  const ownerlessTasks = nonTerminalTasks.filter(
    (task) => !task.ownerAgentId,
  ).length;
  const dispatchedTaskIds = new Set(
    workstream.messages
      .filter(
        (message) =>
          message.taskId && openDeliveryStatuses.has(message.deliveryStatus),
      )
      .map((message) => message.taskId!),
  );
  const assignedButUndispatchedTasks = nonTerminalTasks.filter(
    (task) => task.status === "assigned" && !dispatchedTaskIds.has(task.id),
  ).length;
  const counts = Object.entries(taskCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");

  return {
    episodeKey,
    message: `Active workstream stalled: tasks by status {${counts}}; ownerless=${ownerlessTasks}; assigned-but-undispatched=${assignedButUndispatchedTasks}`,
    taskCounts,
    ownerlessTasks,
    assignedButUndispatchedTasks,
  };
}

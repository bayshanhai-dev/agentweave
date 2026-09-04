export type RuntimeUsage = {
  source: "provider" | "estimated" | "unknown";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};
export type RuntimeAgentProjection = {
  agentId: string;
  role: string;
  status: string;
  activity: string;
  waitingReason?: string;
  providerState: "healthy" | "degraded" | "unavailable";
  lastSignalAt?: string;
  stale: boolean;
  latencyMs?: number;
  usage: RuntimeUsage;
};
type Agent = { id: string; role: string; status: string };
type Task = { status: string; ownerAgentId?: string; title: string };
type Event = {
  type?: string;
  message?: string;
  agentId?: string;
  role?: string;
  toolName?: string;
  elapsedMs?: number;
  occurredAt?: string;
  correlationId?: string;
  taskId?: string;
  usage?: RuntimeUsage;
};

const activeTypes = new Set([
  "run.started",
  "run.heartbeat",
  "turn.started",
  "turn.delta",
  "tool.started",
  "tool.completed",
]);

function usageFor(events: Event[]): RuntimeUsage {
  const turns = new Map<string, RuntimeUsage>();
  for (const event of events) {
    if (!event.usage) continue;
    const key = event.correlationId ?? event.taskId ?? event.type ?? "unknown";
    const previous = turns.get(key);
    const total =
      event.usage.totalTokens ??
      (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0);
    const previousTotal =
      previous?.totalTokens ??
      (previous?.inputTokens ?? 0) + (previous?.outputTokens ?? 0);
    if (!previous || total >= previousTotal) turns.set(key, event.usage);
  }
  if (!turns.size) return { source: "unknown" };
  return [...turns.values()].reduce(
    (total, usage) => ({
      source: usage.source === "provider" ? "provider" : total.source,
      inputTokens: (total.inputTokens ?? 0) + (usage.inputTokens ?? 0),
      outputTokens: (total.outputTokens ?? 0) + (usage.outputTokens ?? 0),
      totalTokens:
        (total.totalTokens ?? 0) +
        (usage.totalTokens ??
          (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
      costUsd: (total.costUsd ?? 0) + (usage.costUsd ?? 0),
    }),
    { source: "estimated" } as RuntimeUsage,
  );
}

export function projectRuntime(
  input: { status: string; agents: Agent[]; tasks: Task[]; events: Event[] },
  now = Date.now(),
  staleAfterMs = 30_000,
) {
  const agents = input.agents.map((agent): RuntimeAgentProjection => {
    const events = input.events.filter(
      (event) => event.agentId === agent.id || event.role === agent.role,
    );
    const latest = [...events].reverse().find((event) => event.type);
    const lastSignalAt = latest?.occurredAt;
    const age = lastSignalAt
      ? now - Date.parse(lastSignalAt)
      : Number.POSITIVE_INFINITY;
    const stale =
      agent.status === "running" &&
      (!Number.isFinite(age) || age > staleAfterMs);
    const assigned = input.tasks.find(
      (task) =>
        task.ownerAgentId === agent.id &&
        !["done", "failed", "cancelled"].includes(task.status),
    );
    const active =
      agent.status === "running" ||
      Boolean(latest?.type && activeTypes.has(latest.type));
    const waitingReason =
      agent.status === "paused"
        ? "Paused by operator"
        : agent.status === "failed"
          ? "Provider or task failure needs attention"
          : !active
            ? assigned
              ? `Waiting to run: ${assigned.title}`
              : "Waiting for work"
            : undefined;
    const activity = stale
      ? "Provider signal is stale"
      : latest?.type === "tool.started"
        ? `Using ${latest.toolName ?? "a tool"}`
        : active
          ? (latest?.message ?? "Provider turn in progress")
          : (waitingReason ?? "Waiting for work");
    return {
      agentId: agent.id,
      role: agent.role,
      status: agent.status,
      activity,
      ...(waitingReason ? { waitingReason } : {}),
      providerState:
        stale || agent.status === "failed"
          ? "degraded"
          : lastSignalAt
            ? "healthy"
            : "unavailable",
      ...(lastSignalAt ? { lastSignalAt } : {}),
      stale,
      ...(latest?.elapsedMs !== undefined
        ? { latencyMs: latest.elapsedMs }
        : {}),
      usage: usageFor(events),
    };
  });
  const activeAgents = agents.filter(
    (agent) => agent.status === "running" && !agent.stale,
  ).length;
  const degradedAgents = agents.filter(
    (agent) => agent.providerState === "degraded",
  ).length;
  const latest = [...input.events].reverse().find((event) => event.occurredAt);
  const headline =
    input.status === "waiting_for_human"
      ? "Waiting for Human review"
      : degradedAgents
        ? `${degradedAgents} agent${degradedAgents === 1 ? "" : "s"} need attention`
        : activeAgents
          ? `${activeAgents} agent${activeAgents === 1 ? "" : "s"} working`
          : input.status === "completed"
            ? "Workstream completed"
            : "Workstream is waiting for runnable work";
  return {
    generatedAt: new Date(now).toISOString(),
    status: input.status,
    headline,
    activeAgents,
    degradedAgents,
    lastActivityAt: latest?.occurredAt,
    agents,
  };
}

import { tokenUsage, type AggregatedTokenUsage } from "./agentUsage";

export type CardAgent = { id: string; role: string; status: string };
export type CardEvent = {
  id?: string;
  type?: string;
  message?: string;
  content?: string;
  role?: string;
  agentId?: string;
  taskId?: string;
  toolName?: string;
  output?: string;
  elapsedMs?: number;
  occurredAt?: string;
  correlationId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
};
export type CardProjection = {
  headline: string;
  agents: Array<{
    agentId: string;
    role: string;
    status: string;
    activity: string;
    waitingReason?: string;
    providerState: "healthy" | "degraded" | "unavailable";
    lastSignalAt?: string;
    stale: boolean;
    latencyMs?: number;
    usage: {
      source: string;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      costUsd?: number;
    };
  }>;
};

export type AgentCardStatus = "running" | "idle" | "failed";

const activeEvents = new Set([
  "run.started",
  "run.heartbeat",
  "turn.started",
  "turn.delta",
  "tool.started",
  "tool.completed",
]);
const settledEvents = new Set([
  "task.completed",
  "task.failed",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
]);

export type AgentCard = {
  agent: CardAgent;
  role: string;
  status: AgentCardStatus;
  activity: string;
  latest?: CardEvent;
  usage: AggregatedTokenUsage;
  stale: boolean;
};

function deriveStatus(agent: CardAgent, events: CardEvent[]): { status: AgentCardStatus; latest?: CardEvent } {
  const agentEvents = events.filter(
    (event) => event.agentId === agent.id || event.role === agent.role,
  );
  const latest = [...agentEvents].reverse().find((event) => event.type);
  if (latest && activeEvents.has(latest.type ?? "")) return { status: "running", latest };
  if (latest && settledEvents.has(latest.type ?? "")) {
    return {
      status: latest.type === "task.failed" || latest.type === "turn.failed" ? "failed" : "idle",
      latest,
    };
  }
  const fallback = agent.status === "running" ? "running" : agent.status === "failed" ? "failed" : "idle";
  return { status: fallback, latest };
}

export function computeAgentCards(
  agents: CardAgent[],
  events: CardEvent[],
  projection?: CardProjection,
): AgentCard[] {
  return agents.map((agent) => {
    const { status, latest } = deriveStatus(agent, events);
    const agentEvents = events.filter(
      (event) => event.agentId === agent.id || event.role === agent.role,
    );
    const projected = projection?.agents.find(
      (candidate) => candidate.agentId === agent.id || candidate.role === agent.role,
    );
    const projectedStatus: AgentCardStatus =
      projected?.status === "running" ? "running" : projected?.status === "failed" ? "failed" : status;
    const usage =
      projected && projected.usage.source !== "unknown"
        ? {
            reported: true,
            inputTokens: projected.usage.inputTokens ?? 0,
            outputTokens: projected.usage.outputTokens ?? 0,
            totalTokens: projected.usage.totalTokens ?? 0,
            costUsd: projected.usage.costUsd ?? 0,
          }
        : tokenUsage(agentEvents);
    const activity =
      projected?.activity ??
      (projectedStatus === "running"
        ? "Processing a live turn"
        : projectedStatus === "failed"
          ? "Needs attention"
          : "Listening for work");
    return {
      agent,
      role: agent.role,
      status: projectedStatus,
      activity,
      latest,
      usage,
      stale: projected?.stale ?? false,
    };
  });
}

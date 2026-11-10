export type TrackedTurn = {
  key: string;
  agentId: string;
  taskId?: string;
  lastSignalAt: number;
};

export type WatchdogAgent = { id: string; status: string };

export function turnKey(input: { workstreamId: string; agentId: string; correlationId?: string; turnId?: string; taskId?: string }): string {
  return [input.workstreamId, input.agentId, input.correlationId ?? input.turnId ?? input.taskId ?? "unknown"].join(":");
}

export function staleTurns(turns: Iterable<TrackedTurn>, now: number, timeoutMs: number): TrackedTurn[] {
  return [...turns].filter((turn) => now - turn.lastSignalAt >= timeoutMs);
}

export function orphanedRunningAgents(agents: readonly WatchdogAgent[], liveAgentIds: ReadonlySet<string>): WatchdogAgent[] {
  return agents.filter((agent) => agent.status === "running" && !liveAgentIds.has(agent.id));
}

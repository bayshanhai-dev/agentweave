export type TrackedTurn = {
  key: string;
  agentId: string;
  taskId?: string;
  lastSignalAt: number;
};

export type WatchdogAgent = { id: string; status: string };

export function turnKey(input: { workstreamId: string; agentId?: string | undefined; correlationId?: string | undefined; turnId?: string | undefined; taskId?: string | undefined }): string {
  return [input.workstreamId, input.agentId ?? "unknown", input.correlationId ?? input.turnId ?? input.taskId ?? "unknown"].join(":");
}

export function staleTurns(turns: Iterable<TrackedTurn>, now: number, timeoutMs: number): TrackedTurn[] {
  return [...turns].filter((turn) => now - turn.lastSignalAt >= timeoutMs);
}

export function orphanedRunningAgents(agents: readonly WatchdogAgent[], liveAgentIds: ReadonlySet<string>): WatchdogAgent[] {
  return agents.filter((agent) => agent.status === "running" && !liveAgentIds.has(agent.id));
}

const TURN_SIGNAL_TYPES = new Set(["run.started", "run.heartbeat", "turn.started", "turn.delta"]);
const TURN_TERMINAL_TYPES = new Set(["turn.completed", "turn.failed", "task.completed", "task.failed"]);

export type TurnSignalEvent = {
  agentId?: string | undefined;
  type?: string | undefined;
  occurredAt: string;
  correlationId?: string | undefined;
  taskId?: string | undefined;
};

/**
 * Reconstruct the single newest live turn from a workstream's event history.
 * A signal event belongs to a live turn when no terminal event for the same
 * agent follows it. One reverse pass (O(n)): agents seen with a terminal
 * event are skipped, so the first unterminated signal found is the newest
 * live turn. The previous implementation re-scanned the whole history for
 * every signal (O(n^2) with Date.parse per candidate); on the production
 * owner workstream (172,971 events, 153,663 of them signals) that spun a
 * full CPU core past the 60s boot health window and the deploy rolled back.
 */
export function reconstructLiveTurn(workstreamId: string, events: readonly TurnSignalEvent[]): TrackedTurn | undefined {
  const terminatedAgents = new Set<string>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (!event.agentId) continue;
    if (TURN_TERMINAL_TYPES.has(event.type ?? "")) {
      terminatedAgents.add(event.agentId);
      continue;
    }
    if (!TURN_SIGNAL_TYPES.has(event.type ?? "")) continue;
    if (terminatedAgents.has(event.agentId)) continue;
    const key = turnKey({ workstreamId, agentId: event.agentId, correlationId: event.correlationId, taskId: event.taskId });
    return { key, agentId: event.agentId, ...(event.taskId ? { taskId: event.taskId } : {}), lastSignalAt: Date.parse(event.occurredAt) };
  }
  return undefined;
}

export type RuntimeProviderEvent = {
  type?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  occurredAt?: string;
};

const runtimeSignalTypes = new Set(["run.started", "run.heartbeat", "turn.started", "turn.completed", "task.completed", "task.failed"]);

function latestProvider(events: readonly RuntimeProviderEvent[], predicate: (event: RuntimeProviderEvent) => boolean): { tool?: string; model?: string } {
  const event = [...events].reverse().find((candidate) => runtimeSignalTypes.has(candidate.type ?? "") && predicate(candidate) && candidate.provider);
  return event?.provider ? { tool: event.provider, ...(event.model ? { model: event.model } : {}) } : {};
}

export function actualProviderForAgent(events: readonly RuntimeProviderEvent[], agentId: string): { provider?: string; model?: string } {
  const route = latestProvider(events, (event) => event.agentId === agentId);
  return { ...(route.tool ? { provider: route.tool } : {}), ...(route.model ? { model: route.model } : {}) };
}

export function actualProviderForWorkstream(events: readonly RuntimeProviderEvent[]): { tool?: string; model?: string } {
  return latestProvider(events, () => true);
}

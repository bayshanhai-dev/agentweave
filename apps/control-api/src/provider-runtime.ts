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

/**
 * Display value for a workstream: the observed worker provider wins when a
 * run has reported one; otherwise the configured provider stays visible so a
 * fresh (never-run) workstream does not render as provider-less.
 */
export function displayProviderForWorkstream(
  events: readonly RuntimeProviderEvent[],
  configured: { tool?: string | undefined; model?: string | undefined },
): { tool?: string; model?: string } {
  const observed = actualProviderForWorkstream(events);
  if (observed.tool) return observed;
  return { ...(configured.tool ? { tool: configured.tool } : {}), ...(configured.model ? { model: configured.model } : {}) };
}

/** Display value for an agent: observed worker provider wins, else the effective configured provider. */
export function displayProviderForAgent(
  events: readonly RuntimeProviderEvent[],
  agentId: string,
  effective: { provider?: string | undefined; model?: string | undefined },
): { provider?: string; model?: string } {
  const observed = actualProviderForAgent(events, agentId);
  if (observed.provider) return observed;
  return { ...(effective.provider ? { provider: effective.provider } : {}), ...(effective.model ? { model: effective.model } : {}) };
}

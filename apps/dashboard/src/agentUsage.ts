export type TokenUsageEvent = {
  id?: string;
  taskId?: string;
  correlationId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
};

export type AggregatedTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  reported: boolean;
};

export function tokenUsage(events: TokenUsageEvent[]): AggregatedTokenUsage {
  const turns = new Map<string, NonNullable<TokenUsageEvent["usage"]>>();

  events.forEach((event) => {
    if (!event.usage) return;
    const key = event.correlationId ?? event.taskId ?? event.id;
    if (!key) return;

    const previous = turns.get(key);
    const previousTotal = previous?.totalTokens ?? (previous?.inputTokens ?? 0) + (previous?.outputTokens ?? 0);
    const nextTotal = event.usage.totalTokens ?? (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0);
    if (!previous || nextTotal >= previousTotal) turns.set(key, event.usage);
  });

  return [...turns.values()].reduce<AggregatedTokenUsage>(
    (total, usage) => ({
      inputTokens: total.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: total.outputTokens + (usage.outputTokens ?? 0),
      totalTokens: total.totalTokens + (usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
      costUsd: total.costUsd + (usage.costUsd ?? 0),
      reported: true,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, reported: false },
  );
}

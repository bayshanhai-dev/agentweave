export type StreamMessage = {
  id?: string;
  senderId?: string;
  recipientIds?: string[];
  from?: string;
  to?: string;
  messageType?: string;
  type?: string;
  taskId?: string;
  correlationId?: string;
  causationId?: string;
  evidenceIds?: string[];
  content?: string;
  message?: string;
  createdAt?: string;
  occurredAt?: string;
};
export type StreamInsight = {
  id: string;
  kind: "proposal" | "critique" | "contradiction" | "synthesis";
  lifecycle: string;
  authorAgentId: string;
  content: string;
  confidence: number;
  references: string[];
  contradictionOf?: string[];
  supersedes?: string[];
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
};
export type UnifiedStreamItem = {
  kind: "message" | "insight";
  id: string;
  authorId?: string;
  recipientIds: string[];
  category: string;
  content: string;
  createdAt?: string;
  taskId?: string;
  correlationId?: string;
  causationId?: string;
  references: string[];
  contradictionOf: string[];
  evidenceIds: string[];
  confidence?: number;
  lifecycle?: string;
};

const timestamp = (value?: string) => {
  const parsed = Date.parse(value ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
};

export function unifiedStream(
  messages: StreamMessage[],
  insights: StreamInsight[],
): UnifiedStreamItem[] {
  return [
    ...messages.map((message, index): UnifiedStreamItem => ({
      kind: "message",
      id: message.id ?? `message-${index}`,
      authorId: message.senderId ?? message.from,
      recipientIds:
        message.recipientIds ?? (message.to ? message.to.split(",") : []),
      category: message.messageType ?? message.type ?? "message",
      content: message.content ?? message.message ?? "",
      createdAt: message.createdAt ?? message.occurredAt,
      taskId: message.taskId,
      correlationId: message.correlationId,
      causationId: message.causationId,
      references: message.causationId ? [message.causationId] : [],
      contradictionOf: [],
      evidenceIds: message.evidenceIds ?? [],
    })),
    ...insights.map((insight): UnifiedStreamItem => ({
      kind: "insight",
      id: insight.id,
      authorId: insight.authorAgentId,
      recipientIds: [],
      category: insight.kind,
      content: insight.content,
      createdAt: insight.createdAt,
      references: insight.references,
      contradictionOf: insight.contradictionOf ?? [],
      evidenceIds: insight.evidenceIds,
      confidence: insight.confidence,
      lifecycle: insight.lifecycle,
    })),
  ].sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt));
}

export function causalNeighbors(insightId: string, insights: StreamInsight[]) {
  const target = insights.find((insight) => insight.id === insightId);
  if (!target) return { supporting: [], opposing: [] };
  const supportingIds = new Set(target.references);
  return {
    supporting: insights.filter((insight) => supportingIds.has(insight.id)),
    opposing: insights.filter(
      (insight) =>
        insight.contradictionOf?.includes(insightId) ||
        target.contradictionOf?.includes(insight.id),
    ),
  };
}

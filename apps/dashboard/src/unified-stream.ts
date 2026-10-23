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

/**
 * Platform-generated instruction messages always carry the `[agentweave ...]`
 * marker (orchestrator stage prompts, implementation triggers, and re-prompts
 * that embed them). A message a human actually typed never does, so the marker
 * is a safe display-layer discriminator between system instructions and real
 * human steers.
 */
export function isSystemInstruction(content: string): boolean {
  return content.includes("[agentweave");
}

export type StructuredContent = { summary: string; details?: string };

function nestedInsightText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // Providers drift on the body field name (the run-13 lesson); accept the
    // variants instead of dropping the text on the floor.
    for (const key of ["content", "text", "body", "insight"]) {
      if (typeof record[key] === "string" && record[key]) return record[key] as string;
    }
  }
  return undefined;
}

/**
 * Agent results arrive either as prose or as a structured JSON envelope
 * (`{ summary, insights: [...] }`). Return the human-first view: the summary
 * up front and everything else as expandable details, so a card never dumps
 * a raw JSON envelope on the reader.
 */
export function parseStructuredContent(content: string): StructuredContent {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.summary === "string" && parsed.summary.trim()) {
        const parts: string[] = [];
        if (Array.isArray(parsed.insights)) {
          for (const entry of parsed.insights) {
            const text = nestedInsightText(entry);
            if (text) parts.push(text);
          }
        }
        const details = parts.length ? parts.join("\n\n") : JSON.stringify(parsed, null, 2);
        return { summary: parsed.summary, details: details === parsed.summary ? undefined : details };
      }
    } catch {
      /* Not JSON after all — fall through and treat it as prose. */
    }
  }
  return { summary: content };
}

/** Short, honest task label: the id's last segment, never a mid-word slice. */
export function taskShortLabel(taskId: string): string {
  const segment = taskId.split(":").at(-1) ?? taskId;
  return segment.length > 24 ? `…${segment.slice(-8)}` : segment;
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

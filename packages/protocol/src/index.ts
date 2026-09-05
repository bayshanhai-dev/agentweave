import { z } from "zod";

export const actorSchema = z.object({
  type: z.enum(["human", "agent", "worker", "system"]),
  id: z.string().min(1),
  role: z.string().min(1).optional(),
});

export const roleTemplateSchema = z.object({
  roleTemplateId: z.string().min(1),
  role: z.string().min(1),
  maxInstances: z.number().int().positive().default(1),
  maxConcurrency: z.number().int().positive().default(1),
});

export const agentInstanceSchema = z.object({
  agentInstanceId: z.string().min(1),
  roleTemplateId: z.string().min(1),
  role: z.string().min(1),
  workstreamId: z.string().min(1),
  sessionId: z.string().min(1),
  status: z.enum([
    "starting",
    "idle",
    "running",
    "paused",
    "draining",
    "archived",
  ]),
  authority: z
    .enum(["executor", "reviewer", "lead", "human_delegate"])
    .default("executor"),
});

export const governedOutputSchema = z.object({
  outputId: z.string().min(1),
  agentInstanceId: z.string().min(1),
  kind: z.enum(["execution", "review", "proposal", "decision", "retro"]),
  evidenceIds: z.array(z.string().min(1)).default([]),
  approvalRequired: z.boolean().default(false),
});

export const scalingRecommendationSchema = z.object({
  recommendationId: z.string().min(1),
  workstreamId: z.string().min(1),
  role: z.string().min(1),
  requestedInstances: z.number().int().positive(),
  reason: z.string().min(1),
  taskIds: z.array(z.string().min(1)).default([]),
  estimatedTokenCost: z.number().nonnegative(),
  status: z
    .enum(["pending", "approved", "rejected", "modified"])
    .default("pending"),
  approvedBy: z.string().min(1).optional(),
});

export const taskLeaseSchema = z.object({
  taskId: z.string().min(1),
  agentInstanceId: z.string().min(1),
  leasedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});

export type RoleTemplate = z.infer<typeof roleTemplateSchema>;
export type AgentInstance = z.infer<typeof agentInstanceSchema>;
export type TaskLease = z.infer<typeof taskLeaseSchema>;
export type GovernedOutput = z.infer<typeof governedOutputSchema>;
export type ScalingRecommendation = z.infer<typeof scalingRecommendationSchema>;

export const humanInputSchema = z.object({
  inputId: z.string().min(1),
  workstreamId: z.string().min(1),
  targetId: z.string().min(1),
  intent: z.enum([
    "question",
    "request",
    "task",
    "directive",
    "command",
    "decision",
    "feedback",
  ]),
  scope: z.enum([
    "message",
    "current_run",
    "current_task",
    "agent",
    "role",
    "workstream",
  ]),
  lifetime: z.enum([
    "one_time",
    "until_task_complete",
    "until_workstream_complete",
    "persistent",
  ]),
  content: z.string().min(1),
});

export type HumanInput = z.infer<typeof humanInputSchema>;

// Workstream controls (pause/resume/complete/emergency-stop) are not chat
// messages. They use the global Control API instead.
export const messageTypeSchema = z.enum([
  "question",
  "request",
  "directive",
  "decision",
  "reply",
  "clarification",
]);
export const deliveryStatusSchema = z.enum([
  "pending",
  "delivered",
  "acknowledged",
  "failed",
]);
export const agentMessageSchema = z.object({
  id: z.string().min(1),
  workstreamId: z.string().min(1),
  senderId: z.string().min(1),
  recipientIds: z.array(z.string().min(1)).min(1),
  messageType: messageTypeSchema,
  content: z.string().min(1),
  taskId: z.string().min(1).optional(),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  evidenceIds: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime(),
  deliveryStatus: deliveryStatusSchema,
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

/** Versioned, provider-neutral result returned after an agent turn. */
export const agentTurnResultSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  summary: z.string().min(1),
  insights: z.array(z.object({ id: z.string().min(1), content: z.string().min(1), kind: z.enum(["proposal", "critique", "contradiction", "synthesis"]).default("proposal"), confidence: z.number().min(0).max(1).default(0.5), references: z.array(z.string().min(1)).default([]), contradictionOf: z.array(z.string().min(1)).default([]), evidenceIds: z.array(z.string().min(1)).default([]) })).default([]),
  tasks: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), ownerRole: z.string().min(1), acceptanceCriteria: z.array(z.string().min(1)).default([]) })).default([]),
  messages: z.array(z.object({ recipientRole: z.string().min(1), content: z.string().min(1), messageType: messageTypeSchema.default("reply"), taskId: z.string().min(1).optional() })).default([]),
  decision: z.object({ action: z.enum(["continue", "complete", "wait", "ask_human"]), reason: z.string().min(1) }).optional(),
  completionProposal: z.object({ reason: z.string().min(1), evidenceIds: z.array(z.string().min(1)).default([]) }).optional(),
  humanBlock: z.object({ question: z.string().min(1), context: z.string().min(1) }).optional(),
});
export type AgentTurnResult = z.infer<typeof agentTurnResultSchema>;

export const providerUsageSchema = z.object({
  source: z.enum(["provider", "estimated", "unknown"]),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});

const providerErrorSchema = z
  .object({
    code: z.string().min(1).optional(),
    message: z.string().min(1),
    category: z.string().min(1).optional(),
    retry: z.string().min(1).optional(),
  })
  .passthrough();

const providerSessionSchema = z
  .object({
    provider: z.string().min(1),
    providerSessionId: z.string().min(1),
    status: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough();

export const runtimeExecutionPayloadSchema = z
  .object({
    type: z.string().min(1),
    taskId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    workstreamId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    text: z.string().optional(),
    structuredResult: agentTurnResultSchema.optional(),
    error: z.union([z.string().min(1), providerErrorSchema]).optional(),
    evidenceIds: z.array(z.string().min(1)).optional(),
    elapsedMs: z.number().nonnegative().optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    usage: providerUsageSchema.optional(),
    session: providerSessionSchema.optional(),
    toolName: z.string().min(1).optional(),
    toolCallId: z.string().min(1).optional(),
    output: z.string().optional(),
    correlationId: z.string().min(1).optional(),
  })
  .passthrough();

export const workflowEventPayloadSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    message: z.string(),
    occurredAt: z.string().datetime(),
  })
  .passthrough();

const messageEventTypes = [
  "message.created",
  "message.delivered",
  "message.acknowledged",
  "message.failed",
  "message.reply.created",
] as const;
const runtimeExecutionEventTypes = [
  "session.started",
  "session.resumed",
  "turn.started",
  "turn.delta",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "tool.started",
  "tool.completed",
  "usage.updated",
  "provider.error",
  "run.started",
  "run.heartbeat",
  "agent.turn.completed",
  "task.completed",
  "task.failed",
] as const;
const workflowEventTypes = [
  "agent.reply.created",
  "approval.complete",
  "approval.reject",
  "approval.resume",
  "message.sent",
  "orchestration.complete.requested",
  "orchestration.decision.applied",
  "orchestration.human_input_requested",
  "orchestration.waiting",
  "task.created",
  "task.decomposition.persisted",
  "task.updated",
  "workstream.active",
  "workstream.complete",
  "workstream.completed",
  "workstream.completing",
  "workstream.completion_proposed",
  "workstream.created",
  "workstream.emergency_stopped",
  "workstream.human_blocked",
  "workstream.pause",
  "workstream.paused",
  "workstream.pausing",
  "workstream.resume",
  "workstream.resumed_by_human_message",
  "workstream.resuming",
  "workstream.starting",
  "workstream.waiting_for_human",
] as const;

export const runtimeEventPayloadRegistry: ReadonlyMap<string, z.ZodType> =
  new Map<string, z.ZodType>([
    ...messageEventTypes.map((type) => [type, agentMessageSchema] as const),
    ...runtimeExecutionEventTypes.map(
      (type) => [type, runtimeExecutionPayloadSchema] as const,
    ),
    ...workflowEventTypes.map(
      (type) => [type, workflowEventPayloadSchema] as const,
    ),
    ["dead-letter", z.string()],
  ]);

export function parseRuntimeEventPayload(
  type: string,
  payload: unknown,
): unknown {
  const schema = runtimeEventPayloadRegistry.get(type);
  if (!schema) throw new Error(`Unsupported runtime event type: ${type}`);
  const parsed = schema.parse(payload);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "type" in parsed &&
    parsed.type !== type
  ) {
    throw new Error(
      `Runtime event payload type ${String(parsed.type)} does not match envelope type ${type}`,
    );
  }
  return parsed;
}

const baseEventEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  schemaVersion: z.number().int().positive().default(1),
  workstreamId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  actor: actorSchema.default({ type: "system", id: "runtime" }),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  sequence: z.number().int().nonnegative().default(0),
  occurredAt: z.string().datetime(),
  payload: z.unknown(),
});

export const eventEnvelopeSchema = baseEventEnvelopeSchema.superRefine(
  (event, context) => {
    try {
      parseRuntimeEventPayload(event.type, event.payload);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type EventEnvelopeInput = Omit<
  EventEnvelope,
  "schemaVersion" | "actor" | "correlationId" | "sequence"
> &
  Partial<
    Pick<
      EventEnvelope,
      "schemaVersion" | "actor" | "correlationId" | "sequence"
    >
  >;

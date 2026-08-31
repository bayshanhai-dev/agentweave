import { z } from "zod";

export const actorSchema = z.object({
  type: z.enum(["human", "agent", "worker", "system"]),
  id: z.string().min(1),
  role: z.string().min(1).optional(),
});

export const eventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  workstreamId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  actor: actorSchema,
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  sequence: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
  payload: z.unknown(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

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
  status: z.enum(["starting", "idle", "running", "paused", "draining", "archived"]),
  authority: z.enum(["executor", "reviewer", "lead", "human_delegate"]).default("executor"),
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
  status: z.enum(["pending", "approved", "rejected", "modified"]).default("pending"),
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
  intent: z.enum(["question", "request", "task", "directive", "command", "decision", "feedback"]),
  scope: z.enum(["message", "current_run", "current_task", "agent", "role", "workstream"]),
  lifetime: z.enum(["one_time", "until_task_complete", "until_workstream_complete", "persistent"]),
  content: z.string().min(1),
});

export type HumanInput = z.infer<typeof humanInputSchema>;

// Workstream controls (pause/resume/complete/emergency-stop) are not chat
// messages. They use the global Control API instead.
export const messageTypeSchema = z.enum(["question", "request", "directive", "decision", "reply"]);
export const deliveryStatusSchema = z.enum(["pending", "delivered", "acknowledged", "failed"]);
export const agentMessageSchema = z.object({
  id: z.string().min(1), workstreamId: z.string().min(1), senderId: z.string().min(1),
  recipientIds: z.array(z.string().min(1)).min(1), messageType: messageTypeSchema,
  content: z.string().min(1), taskId: z.string().min(1).optional(), correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(), evidenceIds: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime(), deliveryStatus: deliveryStatusSchema,
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

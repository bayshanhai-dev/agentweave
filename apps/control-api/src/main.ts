import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { classifyHumanMessage } from "./message-intent.js";
import postgres from "postgres";
import { DeliverPolicy } from "nats";
import { completedTaskIdsForPhaseResult, deriveHandoffTitle, extractTaskSpecs, selectPlannedTask, WorkstreamOrchestrator, type OrchestrationDecision, type OrchestrationPolicy, type TaskSpec } from "./orchestrator.js";
import { JetStreamEventBus, subjects } from "@agentweave/protocol/jetstream";
import { runMigrations } from "./migrations.js";
import { WorkstreamCommandRepository } from "./repositories/workstream-command-repository.js";
import { WorkstreamRepository } from "./repositories/workstream-repository.js";
import { TaskRepository } from "./repositories/task-repository.js";
import { WorkflowEventRepository } from "./repositories/workflow-event-repository.js";
import { MessageRepository } from "./repositories/message-repository.js";
import { RuntimeRepository } from "./repositories/runtime-repository.js";
import { EvidenceRepository } from "./repositories/evidence-repository.js";
import { InsightRepository } from "./repositories/insight-repository.js";
import { TemplateRepository } from "./template-repository.js";
import { WorkstreamCommandError, WorkstreamLifecycleCommandHandler } from "./commands/workstream-lifecycle.js";
import { getWorkstreamTemplate, validateCollaborationRound, validateInsight, validateWorkstreamTemplate, workstreamTemplates, type CollaborationRound, type Insight, type WorkstreamTemplate } from "@agentweave/domain";
import { CollaborationPolicy } from "./collaboration-policy.js";
import { projectRuntime } from "./runtime-projection.js";
import { extractStructuredTaskSpecs, hasStructuredActions, InvalidStructuredTurn, parseStructuredTurn, planStructuredTurn } from "./structured-turn.js";
import { StructuredTurnRepository } from "./repositories/structured-turn-repository.js";
import { collaborationStage, createCollaborationRound, dispatchForDecision, type CollaborationDispatch } from "./collaboration-runtime.js";
import {
  implementationTriggerInstruction,
  implementationTriggerInstructionSeparator,
  implementationTriggerMarker,
  implementationTriggerExists,
  isImplementationTriggerResult,
  republishImplementationTriggerAfterResume,
  shouldDispatchMessage,
} from "./approval-implementation-trigger.js";
import { armTriggerWatchdogForDispatch, durableDispatchTimeoutDecision, publishWithRetry, shouldArmDurableTaskWatchdog, shouldDeferDispatchTimeout, TriggerDispatchWatchdog } from "./dispatch-reliability.js";
import { reconcileDispatchableTasks, reconcileWaveGateAfterActivation } from "./wave-gate-reconciliation.js";
import { reconcileCompletionGate } from "./completion-gate.js";
import { isFinalValidationTask } from "./final-validation.js";

type Role = string;
type ProviderUsage = { source: "provider" | "estimated" | "unknown"; inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number };
type WorkflowEvent = { id: string; sequence?: number; type: string; message: string; role?: Role; from?: string; to?: string; agentId?: string; taskId?: string; toolName?: string; output?: string; elapsedMs?: number; correlationId?: string; provider?: string; model?: string; usage?: ProviderUsage; occurredAt: string };
type Message = { id: string; workstreamId: string; senderId: string; recipientIds: string[]; messageType: string; content: string; taskId?: string; correlationId: string; causationId?: string; evidenceIds: string[]; createdAt: string; deliveryStatus: "pending" | "delivered" | "acknowledged" | "failed" };
type Agent = { id: string; role: Role; authority: "lead" | "reviewer" | "executor"; status: "idle" | "running" | "paused" | "stopped" | "failed" | "done"; orchestrator?: boolean };
type Task = { id: string; workstreamId: string; title: string; status: "ready" | "assigned" | "running" | "review" | "blocked" | "done" | "failed" | "cancelled"; ownerAgentId?: string; createdByAgentId?: string; parentTaskId?: string; relatedTaskIds: string[]; acceptanceCriteria: string[]; dependencies: string[]; evidence: string[]; createdAt: string; updatedAt: string };
type Workstream = { id: string; goal: string; flavor: string; status: string; provider: { tool: string; model: string }; workspaceRoot: string; agents: Agent[]; tasks: Task[]; events: WorkflowEvent[]; messages: Message[] };
type WorkstreamTemplateSummary = Pick<WorkstreamTemplate, "id" | "name" | "description" | "roles" | "taskLanes"> & { builtin: boolean };
const templateSummary = (template: WorkstreamTemplate, builtin: boolean): WorkstreamTemplateSummary => ({
  id: template.id,
  name: template.name,
  description: template.description,
  roles: template.roles,
  taskLanes: template.taskLanes,
  builtin,
});
function jsonArray(value: unknown): string[] { if (Array.isArray(value)) return value.map(String); if (typeof value === "string") { try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; } } return []; }
function normalizeLoadedStatus(status: string, events: Array<{ type: unknown }>): string {
  if (status !== "completing") return status;
  const last = [...events].reverse().find((event) => String(event.type).startsWith("workstream.") || String(event.type).startsWith("approval."));
  if (!last) return "waiting_for_human";
  const type = String(last.type);
  return type.includes("completed") || type.includes("complete") ? "completed" : "waiting_for_human";
}

const app = Fastify({ logger: true });
await app.register(websocket);
const workstreams = new Map<string, Workstream>();
const orchestrators = new Map<string, WorkstreamOrchestrator>();
const decompositionReprompts = new Map<string, number>();
const completionGateTransitions = new Map<string, Promise<boolean>>();
const maxDecompositionReprompts = 2;
const dispatchWatchdog = new TriggerDispatchWatchdog();
const sql = postgres(process.env.DATABASE_URL ?? "postgres://agentweave:agentweave@localhost:5432/agentweave", { max: 5, connect_timeout: 10 });
const commandRepository = new WorkstreamCommandRepository(sql);
const workstreamRepository = new WorkstreamRepository(sql);
const taskRepository = new TaskRepository(sql);
const workflowEventRepository = new WorkflowEventRepository(sql);
const messageRepository = new MessageRepository(sql);
const runtimeRepository = new RuntimeRepository(sql);
const evidenceRepository = new EvidenceRepository(sql);
const insightRepository = new InsightRepository(sql);
const collaborationPolicy = new CollaborationPolicy();
const structuredTurnRepository = new StructuredTurnRepository(sql);
const lifecycleCommandHandler = new WorkstreamLifecycleCommandHandler(commandRepository);
const eventBus = new JetStreamEventBus({ url: process.env.NATS_URL ?? "nats://localhost:4222", durableName: "control-api-events-v4", deliverPolicy: DeliverPolicy.New });
const sockets = new Set<{ send: (data: string) => void }>();
const metrics = { requests: 0, workstreamsCreated: 0, runsStarted: 0, eventsEmitted: 0, workflowFailures: 0, providerInputTokens: 0, providerOutputTokens: 0, providerTotalTokens: 0, providerCostUsd: 0 };
type CommandBody = { commandId?: string; reason?: string; decision?: "resume" | "complete" | "reject" };
const templateRepository = new TemplateRepository(sql);
// Custom templates are persisted in PostgreSQL and mirrored in memory so the
// (synchronous) template resolution used across the control plane keeps working.
// Single-host deployment: writes go through this process, so the mirror cannot diverge.
const customTemplates: WorkstreamTemplate[] = [];
const isBuiltinTemplate = (templateId: string): boolean => workstreamTemplates.some((builtin) => builtin.id === templateId);
const resolveTemplate = (templateId: string): WorkstreamTemplate | undefined =>
  getWorkstreamTemplate(templateId, customTemplates);
const allTemplates = (): WorkstreamTemplate[] => [...workstreamTemplates, ...customTemplates];
const workstreamResponse = (workstream: Workstream) => {
  const template = resolveTemplate(workstream.flavor);
  return { ...workstream, ...(template ? { template: templateSummary(template, isBuiltinTemplate(template.id)) } : {}) };
};
const orchestrationPolicyFor = (workstream: Workstream): OrchestrationPolicy => {
  const template = resolveTemplate(workstream.flavor);
  if (!template) throw new Error(`Unknown workstream template: ${workstream.flavor}`);
  return { templateId: template.id, ...template.orchestration };
};

app.addHook("onRequest", async (request, reply) => {
  metrics.requests += 1;
  reply.header("access-control-allow-origin", "*");
  reply.header("access-control-allow-methods", "GET,POST,DELETE,PATCH,OPTIONS");
  reply.header("access-control-allow-headers", "content-type");
  if (request.method === "OPTIONS") return reply.code(204).send();
});
app.get("/health", async () => ({ status: "ok", service: "control-api" }));
app.get("/metrics", async (_request, reply) => {
  reply.type("text/plain; version=0.0.4");
  return Object.entries(metrics)
    .map(([name, value]) => `agentweave_${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)} ${value}`)
    .join("\n") + "\n";
});
app.post("/api/runtime/workers/register", async (request, reply) => {
  const body = request.body as { workerId?: string; provider?: string; providerModel?: string; endpoint?: string | null; roles?: string[]; capabilities?: string[] } | undefined;
  if (!body?.workerId?.trim()) return reply.code(400).send({ error: "worker_id_required" });
  await runtimeRepository.registerWorker({ workerId: body.workerId.trim(), provider: body.provider ?? "unknown", providerModel: body.providerModel ?? "default", ...(body.endpoint !== undefined ? { endpoint: body.endpoint } : {}), roles: body.roles ?? [], capabilities: body.capabilities ?? [] });
  return { workerId: body.workerId.trim(), status: "online" };
});
app.post("/api/runtime/workers/:workerId/heartbeat", async (request, reply) => {
  const workerId = (request.params as { workerId: string }).workerId;
  const found = await runtimeRepository.heartbeatWorker(workerId, (request.body as { taskId?: string } | undefined)?.taskId);
  return found ? { workerId, status: "online" } : reply.code(404).send({ error: "worker_not_registered" });
});
app.get("/api/workstream-templates", async () => allTemplates().map((template) => templateSummary(template, isBuiltinTemplate(template.id))));
app.post("/api/workstream-templates", async (request, reply) => {
  const validation = validateWorkstreamTemplate(request.body);
  if (!validation.ok) return reply.code(400).send({ error: "invalid_template", details: validation.errors });
  const template = validation.template;
  if (isBuiltinTemplate(template.id)) return reply.code(409).send({ error: "builtin_template_id", message: `Template id "${template.id}" is reserved by a built-in template` });
  if (customTemplates.some((existing) => existing.id === template.id)) {
    return reply.code(409).send({ error: "template_id_conflict", message: `Template id "${template.id}" already exists` });
  }
  try {
    await templateRepository.saveCustom(template);
  } catch (error) {
    return reply.code(500).send({ error: "template_persist_failed" });
  }
  customTemplates.push(template);
  app.log.info({ templateId: template.id }, "custom_workstream_template.created");
  return reply.code(201).send(templateSummary(template, false));
});
app.delete("/api/workstream-templates/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (isBuiltinTemplate(id)) return reply.code(403).send({ error: "builtin_template_protected", message: "Built-in templates cannot be deleted" });
  let deleted: boolean;
  try {
    deleted = await templateRepository.deleteCustom(id);
  } catch (error) {
    return reply.code(500).send({ error: "template_delete_failed" });
  }
  if (!deleted) return reply.code(404).send({ error: "template_not_found" });
  const index = customTemplates.findIndex((template) => template.id === id);
  if (index >= 0) customTemplates.splice(index, 1);
  app.log.info({ templateId: id }, "custom_workstream_template.deleted");
  return reply.code(204).send();
});
app.get("/api/workstreams", async () => [...workstreams.values()].map(workstreamResponse));
app.get("/api/workstreams/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const workstream = workstreams.get(id);
  return workstream ? workstreamResponse(workstream) : reply.code(404).send({ error: "workstream_not_found" });
});
app.get("/api/workstreams/:id/snapshot", async (request, reply) => {
  const { id } = request.params as { id: string };
  const workstream = workstreams.get(id);
  if (!workstream) return reply.code(404).send({ error: "workstream_not_found" });
  return { schemaVersion: 1, cursor: Math.max(0, ...workstream.events.map((event) => event.sequence ?? 0)), workstream: workstreamResponse(workstream), runtime: projectRuntime(workstream) };
});
app.get("/api/workstreams/:id/tasks", async (request, reply) => {
  const { id } = request.params as { id: string }; const workstream = workstreams.get(id);
  return workstream ? workstream.tasks : reply.code(404).send({ error: "workstream_not_found" });
});
app.get("/api/workstreams/:id/events", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!workstreams.has(id)) return reply.code(404).send({ error: "workstream_not_found" });
  const after = Number((request.query as { after?: string } | undefined)?.after ?? 0);
  if (!Number.isInteger(after) || after < 0) return reply.code(400).send({ error: "invalid_sequence_cursor" });
  const rows = await workflowEventRepository.listAfter(id, after);
  return rows.map((event) => ({ id: String(event.id), sequence: Number(event.sequence), type: String(event.type), message: String(event.message), ...(event.role ? { role: String(event.role) } : {}), ...(event.from_node ? { from: String(event.from_node) } : {}), ...(event.to_node ? { to: String(event.to_node) } : {}), ...(event.agent_id ? { agentId: String(event.agent_id) } : {}), ...(event.task_id ? { taskId: String(event.task_id) } : {}), occurredAt: new Date(String(event.occurred_at)).toISOString() }));
});
app.get("/api/workstreams/:id/messages", async (request, reply) => {
  const workstream = workstreams.get((request.params as { id: string }).id);
  return workstream ? workstream.messages : reply.code(404).send({ error: "workstream_not_found" });
});
app.get("/api/workstreams/:id/insights", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  if (!workstreams.has(id)) return reply.code(404).send({ error: "workstream_not_found" });
  const [insights, rounds, activeSynthesisInputs] = await Promise.all([insightRepository.listInsights(id), insightRepository.listRounds(id), insightRepository.activeSynthesisInputs(id)]);
  return { insights, rounds, activeSynthesisInputs };
});
app.get("/api/workstreams/:id/insights/:insightId/opposing", async (request, reply) => {
  const { id, insightId } = request.params as { id: string; insightId: string };
  if (!workstreams.has(id)) return reply.code(404).send({ error: "workstream_not_found" });
  return insightRepository.opposingInsights(id, insightId);
});
app.post("/api/workstreams/:id/insights", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const insight = request.body as Insight;
  if (!workstreams.has(id)) return reply.code(404).send({ error: "workstream_not_found" });
  if (!insight || insight.workstreamId !== id) return reply.code(400).send({ error: "invalid_insight_workstream" });
  try { validateInsight(insight, new Set((await insightRepository.listInsights(id)).map((item) => item.id))); } catch (error) { return reply.code(400).send({ error: "invalid_insight", detail: String(error).replace(/^Error: /, "") }); }
  await insightRepository.saveInsight(insight);
  return reply.code(201).send(insight);
});
app.post("/api/workstreams/:id/collaboration-rounds", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const round = request.body as CollaborationRound;
  if (!workstreams.has(id)) return reply.code(404).send({ error: "workstream_not_found" });
  if (!round || round.workstreamId !== id) return reply.code(400).send({ error: "invalid_round_workstream" });
  try { validateCollaborationRound(round, new Set((await insightRepository.listInsights(id)).map((item) => item.id))); } catch (error) { return reply.code(400).send({ error: "invalid_collaboration_round", detail: String(error).replace(/^Error: /, "") }); }
  await insightRepository.saveRound(round);
  emit(workstreams.get(id)!, "collaboration.round.started", `Collaboration round started: ${round.topic}`);
  return reply.code(201).send(round);
});
app.post("/api/workstreams/:id/collaboration-rounds/:roundId/turns", async (request, reply) => {
  const { id, roundId } = request.params as { id: string; roundId: string };
  const workstream = workstreams.get(id); const candidate = request.body as Insight;
  if (!workstream) return reply.code(404).send({ error: "workstream_not_found" });
  const [rounds, insights] = await Promise.all([insightRepository.listRounds(id), insightRepository.listInsights(id)]);
  const round = rounds.find((item) => item.id === roundId);
  if (!round) return reply.code(404).send({ error: "collaboration_round_not_found" });
  try {
    validateInsight(candidate, new Set(insights.map((item) => item.id)));
    const decision = collaborationPolicy.evaluate(round, insights.filter((item) => round.insightIds.includes(item.id)), candidate);
    if (decision.accepted) await insightRepository.saveInsight(candidate);
    await insightRepository.saveRound(decision.round);
    emit(workstream, decision.stopReason ? "collaboration.round.stopped" : "collaboration.turn.accepted", decision.stopReason ? `${decision.stopReason}: ${decision.reason}` : `${candidate.kind}: ${decision.reason}`, workstream.agents.find((agent) => agent.id === candidate.authorAgentId)?.role);
    return reply.code(decision.accepted ? 201 : 200).send(decision);
  } catch (error) { return reply.code(400).send({ error: "invalid_collaboration_turn", detail: String(error).replace(/^Error: /, "") }); }
});
app.post("/api/workstreams/:id/orchestration/decisions", async (request, reply) => {
  const { id } = request.params as { id: string };
  const workstream = workstreams.get(id);
  const body = request.body as OrchestrationDecision & { actorId?: string } | undefined;
  if (!workstream) return reply.code(404).send({ error: "workstream_not_found" });
  const pm = workstream.agents.find((agent) => agent.role === "pm");
  if (!pm || body?.actorId !== pm.id) return reply.code(403).send({ error: "orchestration_decision_requires_pm_lead" });
  if (["paused", "completed", "emergency_stopped", "archived"].includes(workstream.status)) return reply.code(409).send({ error: "workstream_not_runnable", status: workstream.status });
  const orchestrator = orchestrators.get(id);
  if (!orchestrator || !body) return reply.code(400).send({ error: "decision_required" });
  let decision: OrchestrationDecision;
  try { decision = orchestrator.validateDecision(body); } catch (error) { return reply.code(400).send({ error: "invalid_orchestration_decision", detail: String(error).replace(/^Error: /, "") }); }
  if (decision.action === "complete") {
    workstream.status = "completing";
    emit(workstream, "orchestration.complete.requested", decision.reason, "pm");
    workstream.status = "waiting_for_human";
    await persistWorkstreamStatus(workstream);
  } else if (decision.action === "ask_human") {
    workstream.status = "waiting_for_human";
    emit(workstream, "orchestration.human_input_requested", decision.content ?? decision.reason, "pm");
    await persistWorkstreamStatus(workstream);
  } else if (decision.action === "wait") {
    emit(workstream, "orchestration.waiting", decision.reason, "pm");
  } else {
    const target = workstream.agents.find((agent) => agent.role === decision.targetRole);
    if (!target) return reply.code(404).send({ error: "target_agent_not_found", role: decision.targetRole });
    let taskId: string | undefined;
    if (decision.action === "create_task") {
      const fallbackOwner: TaskSpec["ownerRole"] = decision.targetRole === "coder" ? "coder" : decision.targetRole === "qa" ? "qa" : "pe";
      const specs: TaskSpec[] = decision.tasks?.length ? decision.tasks : [{ title: decision.taskTitle!, ownerRole: fallbackOwner }];
      const created = await createTasks(workstream, specs, pm.id);
      taskId = created[0]?.id;
    }
    await createMessage(workstream, pm.id, [target.id], decision.content ?? decision.taskTitle!, "request", { ...(taskId ? { taskId } : {}) });
    emit(workstream, "orchestration.decision.applied", decision.reason, "pm");
  }
  return { accepted: true, workstreamId: id, decision };
});
for (const command of ["pause", "resume", "complete", "emergency-stop", "waiting-for-human"] as const) {
  app.post(`/api/workstreams/:id/${command}`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const workstream = workstreams.get(id);
    const body = (request.body ?? {}) as CommandBody;
    if (!workstream) return reply.code(404).send({ error: "workstream_not_found" });
    try {
      const previousStatus = workstream.status;
      const response = await lifecycleCommandHandler.execute(workstream, command, body, (type, message) => emit(workstream, type, message));
      if (previousStatus === "waiting_for_human" && workstream.status === "active") await reconcileAfterActivation(workstream);
      return response;
    }
    catch (error) { if (error instanceof WorkstreamCommandError) return reply.code(error.statusCode).send(error.body); throw error; }
  });
}
app.post("/api/workstreams/:id/approval", async (request, reply) => {
  const { id } = request.params as { id: string };
  const workstream = workstreams.get(id);
  const body = (request.body ?? {}) as CommandBody;
  if (!workstream) return reply.code(404).send({ error: "workstream_not_found" });
  try {
    const previousStatus = workstream.status;
    const response = await lifecycleCommandHandler.approve(workstream, body, (type, message) => emit(workstream, type, message));
    if (body.decision === "resume") {
      await republishImplementationTriggerAfterResume(workstream, {
        listRounds: (workstreamId) => insightRepository.listRounds(workstreamId),
        createMessage: (senderId, recipientIds, content, messageType, causationId) =>
          createMessage(workstream, senderId, recipientIds, content, messageType, { causationId }),
        emit: (type, message, role) => emit(workstream, type, message, role),
      });
    }
    if (previousStatus === "waiting_for_human" && workstream.status === "active") await reconcileAfterActivation(workstream);
    return response;
  }
  catch (error) { if (error instanceof WorkstreamCommandError) return reply.code(error.statusCode).send(error.body); throw error; }
});
app.get("/api/workstreams/:id/agents/:agentId/inbox", async (request, reply) => {
  const { id, agentId } = request.params as { id: string; agentId: string };
  if (!workstreams.has(id)) return reply.code(404).send({ error: "workstream_not_found" });
  const rows = await messageRepository.listInboxRows(id, agentId);
  return rows.map((m) => ({ id: String(m.id), workstreamId: String(m.workstream_id), senderId: String(m.sender_id), recipientIds: m.recipient_ids as string[], messageType: String(m.message_type), content: String(m.content), taskId: m.task_id ? String(m.task_id) : undefined, correlationId: String(m.correlation_id), causationId: m.causation_id ? String(m.causation_id) : undefined, evidenceIds: m.evidence_ids as string[], createdAt: new Date(String(m.created_at)).toISOString(), deliveryStatus: String(m.recipient_delivery_status) }));
});
app.patch("/api/workstreams/:id/tasks/:taskId", async (request, reply) => {
  const { id, taskId } = request.params as { id: string; taskId: string }; const workstream = workstreams.get(id);
  const task = workstream?.tasks.find((candidate) => candidate.id === taskId); const body = request.body as { status?: Task["status"]; evidence?: string[] } | undefined;
  if (!workstream || !task) return reply.code(404).send({ error: "task_not_found" });
  if (body?.status) task.status = body.status; if (body?.evidence) task.evidence = body.evidence; task.updatedAt = new Date().toISOString();
  await persistTask(task); emit(workstream, "task.updated", `${task.title} → ${task.status}`);
  await reconcileCompletion(workstream);
  return task;
});
app.post("/api/workstreams/:id/messages", async (request, reply) => {
  const { id } = request.params as { id: string };
  const workstream = workstreams.get(id);
  const body = request.body as { id?: string; from?: string; to?: string; recipients?: string[]; content?: string; intent?: string; taskId?: string; correlationId?: string; causationId?: string; evidenceIds?: string[] } | undefined;
  if (!workstream) return reply.code(404).send({ error: "workstream_not_found" });
  const recipients = [...new Set([...(body?.recipients ?? []), ...(body?.to ? [body.to] : [])].map((id) => id.trim()).filter(Boolean))];
  if (!body?.content?.trim() || !recipients.length) return reply.code(400).send({ error: "recipient_and_content_required" });
  const resolvedRecipients = recipients.map((recipient) => recipient === "human" ? recipient : workstream.agents.find((candidate) => candidate.id === recipient || candidate.role === recipient)?.id ?? recipient);
  const { content, messageType } = classifyHumanMessage(body.content, body.intent);
  const humanToLead = body.from?.trim() === "human" && resolvedRecipients.some((recipient) => workstream.agents.find((agent) => agent.id === recipient)?.role === orchestrationPolicyFor(workstream).leadRole);
  // A Human message to PM is an explicit resume signal while the Workstream is
  // waiting. Persist active before publishing the inbox message: otherwise the
  // Worker correctly sees waiting_for_human and acks the delivery without a turn.
  if (humanToLead && workstream.status === "waiting_for_human") {
    workstream.status = "active";
    orchestrators.set(workstream.id, new WorkstreamOrchestrator(workstream.id, workstream.goal, orchestrationPolicyFor(workstream)));
    await persistWorkstreamStatus(workstream);
    emit(workstream, "workstream.resumed_by_human_message", "Human resumed the Workstream through PM");
    await reconcileAfterActivation(workstream);
  }
  let taskId = body.taskId;
  if (messageType === "request" && !taskId) {
    const now = new Date().toISOString();
    const pmOwner = humanToLead ? workstream.agents.find((agent) => agent.role === orchestrationPolicyFor(workstream).leadRole) : undefined;
    const task: Task = { id: `${workstream.id}:human-${randomUUID()}`, workstreamId: workstream.id, title: content, status: pmOwner ? "assigned" : "ready", ...(pmOwner ? { ownerAgentId: pmOwner.id } : {}), acceptanceCriteria: ["Human request is addressed and evidence is attached"], dependencies: [], evidence: [], relatedTaskIds: [], createdAt: now, updatedAt: now };
    workstream.tasks.push(task);
    await persistTask(task);
    emit(workstream, "task.created", `Human request queued: ${task.title}`);
    taskId = task.id;
  }
  const message = await createMessage(workstream, body.from?.trim() || "human", resolvedRecipients, content, messageType, { ...body, ...(taskId ? { taskId } : {}) }, body.id);
  return reply.code(201).send(message);
});
app.post("/api/workstreams/:id/messages/:messageId/reply", async (request, reply) => {
  const { id, messageId } = request.params as { id: string; messageId: string };
  const workstream = workstreams.get(id); const original = workstream?.messages.find((message) => message.id === messageId);
  const body = request.body as { from?: string; content?: string } | undefined;
  if (!workstream || !original) return reply.code(404).send({ error: "message_not_found" });
  if (!body?.content?.trim() || !body.from?.trim()) return reply.code(400).send({ error: "sender_and_content_required" });
  const created = await createMessage(workstream, body.from.trim(), [original.senderId], body.content.trim(), "reply", { correlationId: original.correlationId, causationId: original.id });
  emitMessage(workstream, "message.reply.created", created);
  return reply.code(201).send(created);
});
app.post("/api/workstreams/:id/messages/:messageId/ack", async (request, reply) => updateDelivery(request, reply, "acknowledged"));
app.post("/api/workstreams/:id/messages/:messageId/fail", async (request, reply) => updateDelivery(request, reply, "failed"));
app.post("/api/workstreams/:id/start", async (request, reply) => {
  const id = (request.params as { id: string }).id; const workstream = workstreams.get(id);
  if (!workstream) return reply.code(404).send({ error: "workstream_not_found" });
  if (workstream.status !== "draft") return reply.code(409).send({ error: "workstream_not_draft", status: workstream.status });
  workstream.status = "starting"; await persistWorkstreamStatus(workstream); emit(workstream, "workstream.starting", "Human started the Workstream");
  await startOrchestration(workstream); return workstream;
});
app.post("/api/workstreams", async (request, reply) => {
  const body = request.body as { goal?: string; templateId?: string; flavor?: string; tool?: string; model?: string; workspaceRoot?: string } | undefined;
  if (!body?.goal?.trim()) return reply.code(400).send({ error: "goal_required" });
  const flavor = body.templateId ?? body.flavor ?? "software-development";
  const template = resolveTemplate(flavor);
  if (!template) return reply.code(400).send({ error: "unsupported_template", availableTemplates: allTemplates().map((candidate) => candidate.id) });
  const id = randomUUID();
  const workstream: Workstream = {
    id, goal: body.goal.trim(), flavor, status: "draft",
    provider: { tool: body.tool ?? "mock", model: body.model ?? "deterministic" },
    workspaceRoot: body.workspaceRoot?.trim() || "/workspaces/agentweave", tasks: [], events: [], messages: [],
    agents: template.roles.map((role, index) => ({ id: `${id}:${role.id}-${index + 1}`, role: role.id, authority: role.authority, status: "idle", ...(role.id === template.orchestration.leadRole ? { orchestrator: true } : {}) })),
  };
  workstreams.set(id, workstream);
  await persistWorkstream(workstream);
  metrics.workstreamsCreated += 1;
  app.log.info({ workstreamId: id, templateId: template.id, provider: workstream.provider, workspaceRoot: workstream.workspaceRoot }, "workstream.created");
  emit(workstream, "workstream.created", `${template.name} workstream created`);
  return reply.code(201).send(workstreamResponse(workstream));
});
app.get("/events", { websocket: true }, async (socket, request) => {
  sockets.add(socket);
  socket.send(JSON.stringify({ type: "system.connected", occurredAt: new Date().toISOString() }));
  const query = request.query as { after?: string; afterSequence?: string; workstreamId?: string } | undefined;
  const after = query?.after;
  const afterSequence = query?.afterSequence;
  const replayWorkstreamId = query?.workstreamId;
  if (replayWorkstreamId && afterSequence !== undefined) {
    const sequence = Number(afterSequence);
    if (Number.isInteger(sequence) && sequence >= 0) {
      const rows = await workflowEventRepository.listAfter(replayWorkstreamId, sequence);
      for (const row of rows) socket.send(JSON.stringify({ workstreamId: replayWorkstreamId, id: String(row.id), sequence: Number(row.sequence), type: String(row.type), message: String(row.message), ...(row.role ? { role: String(row.role) } : {}), ...(row.from_node ? { from: String(row.from_node) } : {}), ...(row.to_node ? { to: String(row.to_node) } : {}), occurredAt: new Date(String(row.occurred_at)).toISOString() }));
    }
  }
  if (after) {
    const rows = await messageRepository.listRowsAfter(after);
    for (const row of rows) {
      const message: Message = { id: String(row.id), workstreamId: String(row.workstream_id), senderId: String(row.sender_id), recipientIds: row.recipient_ids as string[], messageType: String(row.message_type), content: String(row.content), ...(row.task_id ? { taskId: String(row.task_id) } : {}), correlationId: String(row.correlation_id), ...(row.causation_id ? { causationId: String(row.causation_id) } : {}), evidenceIds: row.evidence_ids as string[], createdAt: new Date(String(row.created_at)).toISOString(), deliveryStatus: String(row.delivery_status) as Message["deliveryStatus"] };
      socket.send(JSON.stringify({ workstreamId: message.workstreamId, type: "message.created", message, occurredAt: message.createdAt }));
    }
  }
  socket.on("close", () => sockets.delete(socket));
});

function emit(workstream: Workstream, type: string, message: string, role?: Role): void {
  // waiting_for_human deliberately does not clear dispatch watchdogs: a gate
  // holds handoffs legitimately, and the watchdog callbacks defer (and
  // re-arm) until the Workstream is active again. Clearing here would strip
  // timeout protection from every handoff created before the gate.
  if (["workstream.completed", "workstream.emergency_stopped", "workstream.archived", "orchestration.decomposition_failed"].includes(type)) {
    dispatchWatchdog.clear(workstream.id);
  }
  const event: WorkflowEvent = { id: randomUUID(), type, message, occurredAt: new Date().toISOString(), ...(role ? { role } : {}) };
  recordWorkflowEvent(workstream, event);
  void (async () => {
    try {
      await eventBus.publish(subjects.events.replace("*", workstream.id), { id: event.id, type, workstreamId: workstream.id, occurredAt: event.occurredAt, payload: event });
    } catch (error) {
      app.log.error({ error, workstreamId: workstream.id, eventId: event.id, eventType: event.type }, "workflow.event.publish_failed");
    }
  })();
}

function recordWorkflowEvent(workstream: Workstream, event: WorkflowEvent): void {
  // Sequence is allocated atomically by WorkflowEventRepository.append (SELECT ... FOR UPDATE
  // on the workstream row + MAX(sequence)+1 in one transaction). Never pre-compute it here:
  // concurrent emitters derive the same value from a stale in-memory list and violate the
  // (workstream_id, sequence) unique constraint, crashing the process (e2e red on #53).
  workstream.events.push(event);
  void persistEvent(workstream.id, event).catch((error) => {
    app.log.error({ error, workstreamId: workstream.id, eventId: event.id, eventType: event.type }, "workflow.event.persist_failed");
  });
  void persistWorkstreamStatus(workstream).catch((error) => {
    app.log.error({ error, workstreamId: workstream.id, eventId: event.id, eventType: event.type }, "workflow.status.persist_failed");
  });
  metrics.eventsEmitted += 1;
  if (event.type === "run.started") metrics.runsStarted += 1;
  if (event.type === "usage.updated" && event.usage) {
    metrics.providerInputTokens += event.usage.inputTokens ?? 0;
    metrics.providerOutputTokens += event.usage.outputTokens ?? 0;
    metrics.providerTotalTokens += event.usage.totalTokens ?? 0;
    metrics.providerCostUsd += event.usage.costUsd ?? 0;
  }
  app.log.info({ workstreamId: workstream.id, eventId: event.id, eventType: event.type, role: event.role }, "workflow.event");
  const payload = JSON.stringify({ workstreamId: workstream.id, ...event });
  for (const socket of sockets) socket.send(payload);
}

async function createMessageEvent(workstream: Workstream, from: string, to: string, content: string, intent: string): Promise<WorkflowEvent> {
  const event: WorkflowEvent = { id: randomUUID(), type: "message.sent", message: content, from, to, occurredAt: new Date().toISOString() };
  workstream.events.push(event);
  // Let the repository allocate the sequence atomically (see recordWorkflowEvent); passing a
  // pre-computed value here would bypass the row lock and risk duplicate sequences.
  event.sequence = await workflowEventRepository.append(workstream.id, { ...event, role: intent });
  app.log.info({ workstreamId: workstream.id, eventId: event.id, eventType: event.type, from, to, intent }, "message.sent");
  const payload = JSON.stringify({ workstreamId: workstream.id, ...event });
  for (const socket of sockets) socket.send(payload);
  return event;
}

async function createMessage(workstream: Workstream, senderId: string, recipientIds: string[], content: string, messageType: string, extra: { taskId?: string; correlationId?: string; causationId?: string; evidenceIds?: string[] }, requestedId?: string): Promise<Message> {
  const now = new Date().toISOString();
  const existing = requestedId ? workstream.messages.find((candidate) => candidate.id === requestedId) : undefined;
  if (existing) return existing;
  if (requestedId) {
    const row = await messageRepository.findRow(workstream.id, requestedId);
    if (row) {
      const restored: Message = { id: String(row.id), workstreamId: String(row.workstream_id), senderId: String(row.sender_id), recipientIds: row.recipient_ids as string[], messageType: String(row.message_type), content: String(row.content), ...(row.task_id ? { taskId: String(row.task_id) } : {}), correlationId: String(row.correlation_id), ...(row.causation_id ? { causationId: String(row.causation_id) } : {}), evidenceIds: row.evidence_ids as string[], createdAt: new Date(String(row.created_at)).toISOString(), deliveryStatus: String(row.delivery_status) as Message["deliveryStatus"] };
      workstream.messages.push(restored);
      return restored;
    }
  }
  const message: Message = { id: requestedId ?? randomUUID(), workstreamId: workstream.id, senderId, recipientIds, messageType, content, ...(extra.taskId ? { taskId: extra.taskId } : {}), correlationId: extra.correlationId ?? randomUUID(), ...(extra.causationId ? { causationId: extra.causationId } : {}), evidenceIds: extra.evidenceIds ?? [], createdAt: now, deliveryStatus: "pending" };
  await messageRepository.create(message);
  workstream.messages.push(message);
  emitMessage(workstream, "message.created", message);
  if (!shouldDispatchMessage(message.senderId, message.content)) {
    const senderRole = workstream.agents.find((agent) => agent.id === message.senderId)?.role;
    emit(workstream, "orchestration.agent_directive_suppressed", `Agent-authored implementation directive suppressed for message ${message.id}`, senderRole);
    return message;
  }
  const policy = orchestrationPolicyFor(workstream);
  const lead = workstream.agents.find((agent) => agent.role === policy.leadRole);
  const failedRecipients: Array<{ recipientId: string; error: unknown }> = [];
  for (const recipientId of message.recipientIds) {
    try {
      await publishWithRetry(() => eventBus.publish(subjects.inbox.replace("*", recipientId), {
        id: `${message.id}:${recipientId}`, type: "message.created", workstreamId: workstream.id,
        occurredAt: message.createdAt, correlationId: message.correlationId,
        ...(message.causationId ? { causationId: message.causationId } : {}), payload: message,
      }));
      armDispatchWatchdogAfterPublish(workstream, message, recipientId, lead);
    } catch (error) {
      failedRecipients.push({ recipientId, error });
      await messageRepository.updateDelivery(message.id, recipientId, "failed");
      emit(workstream, "message.dispatch_failed", `Inbox dispatch failed for recipient ${recipientId}, message ${message.id}`);
      app.log.error({ error, workstreamId: workstream.id, recipientId, messageId: message.id }, "message.dispatch_failed");
    }
  }
  if (failedRecipients.length) {
    message.deliveryStatus = "failed";
    const leadTriggerFailed = lead && message.content.includes(implementationTriggerMarker) && failedRecipients.some(({ recipientId }) => recipientId === lead.id);
    if (lead && leadTriggerFailed) {
      await setAgentStatus(lead, "idle");
      await recoverDecomposition(workstream, lead, { id: message.id, correlationId: message.correlationId }, { reason: `inbox dispatch failed for message ${message.id}` });
    }
    return message;
  }
  message.deliveryStatus = "delivered";
  await messageRepository.markDelivered(message.id);
  emitMessage(workstream, "message.delivered", message);
  return message;
}

function armDispatchWatchdogAfterPublish(workstream: Workstream, message: Message, recipientId: string, lead: Agent | undefined): void {
  if (lead) {
    const onTriggerWatchdogExpired = async (): Promise<void> => {
      if (shouldDeferDispatchTimeout(workstream.status)) {
        // A gate defers the decision; re-arm instead of consuming the
        // one-shot timer, so protection resumes when the gate releases.
        dispatchWatchdog.arm(workstream.id, message.correlationId, onTriggerWatchdogExpired);
        return;
      }
      try {
        app.log.error({ workstreamId: workstream.id, recipientId: lead.id, messageId: message.id, correlationId: message.correlationId }, "implementation trigger dispatch timed out");
        await setAgentStatus(lead, "idle");
        await recoverDecomposition(workstream, lead, { id: message.id, correlationId: message.correlationId }, { reason: `no turn.started or result within 180 seconds for message ${message.id}` });
      } catch (error) {
        app.log.error({ error, workstreamId: workstream.id, recipientId: lead.id, messageId: message.id }, "implementation trigger recovery failed");
      }
    };
    if (armTriggerWatchdogForDispatch(dispatchWatchdog, workstream.id, message.correlationId, message.content, recipientId, lead.id, onTriggerWatchdogExpired)) return;
  }
  if (!shouldArmDurableTaskWatchdog(message.taskId, message.content, recipientId)) return;
  const onDurableWatchdogExpired = async (): Promise<void> => {
    if (shouldDeferDispatchTimeout(workstream.status)) {
      // A gate defers the decision; re-arm instead of consuming the
      // one-shot timer, so protection resumes when the gate releases.
      dispatchWatchdog.arm(workstream.id, message.correlationId, onDurableWatchdogExpired);
      return;
    }
    const task = workstream.tasks.find((candidate) => candidate.id === message.taskId);
    const priorHandoff = message.causationId
      ? workstream.messages.find((candidate) => candidate.id === message.causationId && candidate.taskId === message.taskId)
      : undefined;
    const decision = durableDispatchTimeoutDecision(task?.status, Boolean(priorHandoff));
    if (!task || decision === "ignore") return;
    const failDispatch = async (reason: string): Promise<void> => {
      task.status = "failed";
      task.updatedAt = new Date().toISOString();
      await persistTask(task);
      await reconcileTaskDispatches(workstream);
      const recipient = workstream.agents.find((candidate) => candidate.id === recipientId);
      if (recipient) await setAgentStatus(recipient, "idle");
      workstream.status = "waiting_for_human";
      await persistWorkstreamStatus(workstream);
      recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.failed", message: `${task.title} → ${reason}`, occurredAt: new Date().toISOString(), taskId: task.id, ...(recipient?.role ? { role: recipient.role } : {}), ...(recipient?.id ? { agentId: recipient.id } : {}) });
      recordWorkflowEvent(workstream, { id: randomUUID(), type: "workstream.waiting_for_human", message: "Durable task dispatch failed twice; Human decision required", occurredAt: new Date().toISOString() });
    };
    if (decision === "fail") {
      await failDispatch("dispatch timed out after re-drive");
      return;
    }
    app.log.error({ workstreamId: workstream.id, recipientId, messageId: message.id, correlationId: message.correlationId }, "durable task dispatch timed out; re-driving with a fresh handoff");
    const recipient = workstream.agents.find((candidate) => candidate.id === recipientId);
    if (recipient) await setAgentStatus(recipient, "idle");
    const redrive = await createMessage(workstream, message.senderId, [recipientId], message.content, message.messageType, {
      taskId: task.id,
      causationId: message.id,
      evidenceIds: message.evidenceIds,
    });
    if (redrive.deliveryStatus !== "delivered") {
      await failDispatch("re-drive could not be delivered");
      return;
    }
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "message.dispatch_redriven", message: `Durable task handoff re-driven with fresh correlation ${redrive.correlationId}`, occurredAt: new Date().toISOString(), taskId: task.id, correlationId: redrive.correlationId, ...(recipient?.role ? { role: recipient.role } : {}), ...(recipient?.id ? { agentId: recipient.id } : {}) });
  };
  dispatchWatchdog.arm(workstream.id, message.correlationId, onDurableWatchdogExpired);
}

function emitMessage(workstream: Workstream, type: string, message: Message): void {
  const payload = JSON.stringify({ workstreamId: workstream.id, type, message, occurredAt: new Date().toISOString() });
  for (const socket of sockets) socket.send(payload);
  void eventBus.publish(subjects.events.replace("*", workstream.id), { id: `${message.id}:${type}`, type, workstreamId: workstream.id, occurredAt: message.createdAt, correlationId: message.correlationId, ...(message.causationId ? { causationId: message.causationId } : {}), payload: message });
  metrics.eventsEmitted += 1;
}

async function updateDelivery(request: { params: unknown; body?: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }, status: "acknowledged" | "failed") {
  const { id, messageId } = request.params as { id: string; messageId: string };
  const workstream = workstreams.get(id); const body = request.body as { recipientId?: string } | undefined;
  if (!workstream || !workstream.messages.some((message) => message.id === messageId)) return reply.code(404).send({ error: "message_not_found" });
  if (!body?.recipientId) return reply.code(400).send({ error: "recipient_id_required" });
  const message = workstream.messages.find((candidate) => candidate.id === messageId)!;
  const aggregateStatus = await messageRepository.updateDelivery(messageId, body.recipientId, status);
  if (!aggregateStatus && status === "failed") return reply.code(404).send({ error: "message_delivery_not_found" });
  if (aggregateStatus) message.deliveryStatus = aggregateStatus;
  emitMessage(workstream, status === "acknowledged" ? "message.acknowledged" : "message.failed", message);
  return { ...message, recipientId: body.recipientId };
}

async function persistWorkstream(workstream: Workstream): Promise<void> {
  await workstreamRepository.create(workstream);
}

async function persistTask(task: Task): Promise<void> {
  await taskRepository.save(task);
}

async function createTasks(workstream: Workstream, specs: TaskSpec[], creatorAgentId?: string): Promise<Task[]> {
  const now = new Date().toISOString();
  const taskIds = specs.map(() => `${workstream.id}:task-${randomUUID()}`);
  const created: Task[] = specs.map((spec, index) => {
    const owner = spec.ownerRole ? workstream.agents.find((agent) => agent.role === spec.ownerRole) : undefined;
    return {
      id: taskIds[index]!, workstreamId: workstream.id, title: spec.title.trim(), status: owner ? "assigned" : "ready",
      ...(owner ? { ownerAgentId: owner.id } : {}), ...(creatorAgentId ? { createdByAgentId: creatorAgentId } : {}),
      ...(spec.parentTaskId ? { parentTaskId: spec.parentTaskId } : {}), relatedTaskIds: spec.relatedTaskIds ?? [],
      acceptanceCriteria: spec.acceptanceCriteria?.length ? spec.acceptanceCriteria : ["Task is completed with evidence"],
      dependencies: spec.dependsOnAllPrevious ? taskIds.slice(0, index) : spec.dependencies ?? [], evidence: [], createdAt: now, updatedAt: now,
    };
  });
  workstream.tasks.push(...created);
  for (const task of created) { await persistTask(task); emit(workstream, "task.created", `${task.ownerAgentId ? "Task assigned" : "Task queued"}: ${task.title}`, creatorAgentId ? workstream.agents.find((agent) => agent.id === creatorAgentId)?.role : undefined); }
  return created;
}

async function persistWorkstreamStatus(workstream: Workstream): Promise<void> {
  await workstreamRepository.saveState(workstream);
}

async function setAgentStatus(agent: Agent, status: Agent["status"]): Promise<void> {
  if (agent.status === status) return;
  agent.status = status;
  await workstreamRepository.saveAgentStatus(agent.id, status);
}

function dispatchReconciliationDependencies(workstream: Workstream) {
  return {
    hasExecutionClaim: (taskId: string) => runtimeRepository.hasTaskExecutionClaim(workstream.id, taskId),
    dispatchTask: ({ senderId, recipientId, content, taskId, causationId }: { senderId: string; recipientId: string; content: string; taskId: string; causationId?: string }) =>
      createMessage(workstream, senderId, [recipientId], content, "request", {
        taskId,
        ...(causationId ? { causationId } : {}),
      }),
    emit: (type: string, message: string, role?: string) => emit(workstream, type, message, role),
    closeStaleDelivery: async (message: { id: string; recipientIds: string[]; deliveryStatus: string }) => {
      for (const recipientId of message.recipientIds) {
        const aggregate = await messageRepository.updateDelivery(message.id, recipientId, "failed");
        if (!aggregate) return false;
        message.deliveryStatus = aggregate;
      }
      return message.deliveryStatus === "failed";
    },
  };
}

async function reconcileTaskDispatches(workstream: Workstream): Promise<void> {
  await reconcileDispatchableTasks(
    workstream,
    orchestrationPolicyFor(workstream),
    dispatchReconciliationDependencies(workstream),
  );
}

async function reconcileAfterActivation(workstream: Workstream): Promise<void> {
  await reconcileWaveGateAfterActivation(workstream, orchestrationPolicyFor(workstream), {
    acknowledgeGateMessage: async (message) => {
      const aggregateStatus = await messageRepository.updateDelivery(message.id, "human", "acknowledged");
      if (aggregateStatus !== "acknowledged") return false;
      message.deliveryStatus = aggregateStatus;
      emitMessage(workstream, "message.acknowledged", message as Message);
      return true;
    },
    ...dispatchReconciliationDependencies(workstream),
  });
  await reconcileCompletion(workstream);
}

async function reconcileCompletion(workstream: Workstream): Promise<boolean> {
  const existing = completionGateTransitions.get(workstream.id);
  if (existing) return existing;
  const transition = (async () => {
    const policy = orchestrationPolicyFor(workstream);
    const lead = workstream.agents.find((agent) => agent.role === policy.leadRole);
    return reconcileCompletionGate(workstream, {
      createGate: async (content) => {
        const now = new Date().toISOString();
        const message: Message = {
          id: randomUUID(), workstreamId: workstream.id, senderId: lead?.id ?? "human", recipientIds: ["human"], messageType: "decision", content,
          correlationId: randomUUID(), evidenceIds: [], createdAt: now, deliveryStatus: "pending",
        };
        await messageRepository.create(message);
        workstream.messages.push(message);
        emitMessage(workstream, "message.created", message);
        return message;
      },
      persistWaitingForHuman: () => persistWorkstreamStatus(workstream),
      emit: (type, message, role) => emit(workstream, type, message, role),
    });
  })();
  completionGateTransitions.set(workstream.id, transition);
  try {
    return await transition;
  } finally {
    if (completionGateTransitions.get(workstream.id) === transition) completionGateTransitions.delete(workstream.id);
  }
}

async function persistEvent(workstreamId: string, event: WorkflowEvent): Promise<void> {
  // Backfill the atomically allocated sequence onto the in-memory event for consistency.
  event.sequence = await workflowEventRepository.append(workstreamId, event);
}

async function loadWorkstreams(): Promise<void> {
  const rows = await workstreamRepository.listRows();
  for (const row of rows) {
    const agents = await workstreamRepository.listAgentRows(String(row.id));
    const tasks = await taskRepository.listRows(String(row.id));
    const events = await workflowEventRepository.listRows(String(row.id));
    const loadedTasks = tasks.map((task) => ({ id: String(task.id), workstreamId: String(task.workstream_id), title: String(task.title), status: String(task.status) as Task["status"], ...(task.owner_agent_id ? { ownerAgentId: String(task.owner_agent_id) } : {}), ...(task.created_by_agent_id ? { createdByAgentId: String(task.created_by_agent_id) } : {}), ...(task.parent_task_id ? { parentTaskId: String(task.parent_task_id) } : {}), relatedTaskIds: jsonArray(task.related_task_ids), acceptanceCriteria: jsonArray(task.acceptance_criteria), dependencies: jsonArray(task.dependencies), evidence: jsonArray(task.evidence), createdAt: new Date(String(task.created_at)).toISOString(), updatedAt: new Date(String(task.updated_at)).toISOString() }));
    const normalizedStatus = normalizeLoadedStatus(String(row.status), events.map((event) => ({ type: event.type })));
    workstreams.set(String(row.id), {
      id: String(row.id), goal: String(row.goal), flavor: String(row.flavor), status: normalizedStatus,
      provider: { tool: String(row.tool), model: String(row.model) }, workspaceRoot: String(row.workspace_root),
      tasks: loadedTasks,
      agents: agents.map((agent) => ({ id: String(agent.id), role: String(agent.role) as Role, authority: String(agent.authority) as Agent["authority"], status: String(agent.status) as Agent["status"] })),
      messages: [],
      events: events.map((event) => ({ id: String(event.id), sequence: Number(event.sequence), type: String(event.type), message: String(event.message), ...(event.role ? { role: String(event.role) as Role } : {}), ...(event.from_node ? { from: String(event.from_node) } : {}), ...(event.to_node ? { to: String(event.to_node) } : {}), ...(event.agent_id ? { agentId: String(event.agent_id) } : {}), ...(event.task_id ? { taskId: String(event.task_id) } : {}), ...(event.correlation_id ? { correlationId: String(event.correlation_id) } : {}), ...(event.provider ? { provider: String(event.provider) } : {}), ...(event.model ? { model: String(event.model) } : {}), ...(event.usage ? { usage: event.usage as ProviderUsage } : {}), occurredAt: new Date(String(event.occurred_at)).toISOString() })),
    });
    if (normalizedStatus !== String(row.status)) await workstreamRepository.updateStatus(String(row.id), normalizedStatus);
    const messages = await messageRepository.listRows(String(row.id));
    workstreams.get(String(row.id))!.messages = messages.map((m) => ({ id: String(m.id), workstreamId: String(m.workstream_id), senderId: String(m.sender_id), recipientIds: m.recipient_ids as string[], messageType: String(m.message_type), content: String(m.content), ...(m.task_id ? { taskId: String(m.task_id) } : {}), correlationId: String(m.correlation_id), ...(m.causation_id ? { causationId: String(m.causation_id) } : {}), evidenceIds: m.evidence_ids as string[], createdAt: new Date(String(m.created_at)).toISOString(), deliveryStatus: String(m.delivery_status) as Message["deliveryStatus"] }));
  }
  app.log.info({ workstreamCount: workstreams.size }, "workstreams.loaded");
}

const appliedMigrations = await runMigrations(sql);
if (appliedMigrations.length) app.log.info({ migrations: appliedMigrations }, "database.migrated");
try {
  const loaded = await templateRepository.listCustom();
  customTemplates.push(...loaded);
  if (loaded.length) app.log.info({ count: loaded.length }, "custom_workstream_templates.loaded");
} catch (error) {
  app.log.warn({ error }, "custom_workstream_templates.load_failed");
}
await eventBus.connect();
await loadWorkstreams();
for (const workstream of workstreams.values()) {
  if (workstream.status === "active") await reconcileAfterActivation(workstream);
}
await eventBus.consumer(subjects.events, async (message) => {
  const envelope = eventBus.decode(message) as { id?: string; type: string; workstreamId: string; payload: unknown; correlationId?: string };
  if (envelope.id) {
    const claimed = await runtimeRepository.claimEvent(envelope.id, envelope.workstreamId, envelope.type);
    if (!claimed) return "ack";
    try {
      await handleWorkerResult(envelope);
    } catch (error) {
      await runtimeRepository.releaseEvent(envelope.id);
      throw error;
    }
  } else {
    await handleWorkerResult(envelope);
  }
  return "ack";
});
setInterval(() => { void runtimeRepository.markStaleWorkersOffline(); }, 15_000);
// Periodic dispatch reconciliation: event-driven reconciliation only runs
// when something else happens, so a lost handoff in an otherwise quiet
// Workstream would never be retried. The sweep re-drives stale, unclaimed
// handoffs (and dispatches newly dependency-ready tasks) every minute.
setInterval(() => {
  for (const workstream of workstreams.values()) {
    if (workstream.status !== "active") continue;
    void reconcileTaskDispatches(workstream).catch((error) => {
      app.log.error({ error, workstreamId: workstream.id }, "dispatch reconciliation sweep failed");
    });
  }
}, 60_000).unref();

async function startOrchestration(workstream: Workstream): Promise<void> {
  const policy = orchestrationPolicyFor(workstream);
  const orchestrator = new WorkstreamOrchestrator(workstream.id, workstream.goal, policy); orchestrators.set(workstream.id, orchestrator);
  workstream.status = "active"; emit(workstream, "workstream.active", "Workflow started");
  try {
    const { round, dispatches } = createCollaborationRound(workstream.id, workstream.goal, workstream.agents);
    await insightRepository.saveRound(round);
    emit(workstream, "collaboration.round.started", "Agent-owned collaboration round started");
    for (const dispatch of dispatches) await dispatchCollaboration(workstream, round.id, dispatch, "human");
  } catch (error) {
    app.log.warn({ workstreamId: workstream.id, error }, "Collaboration unavailable; using legacy orchestration");
    const action = orchestrator.start(); const lead = workstream.agents.find((candidate) => candidate.role === policy.leadRole)!;
    const existingBootstrap = workstream.tasks.find((task) => task.ownerAgentId === lead.id && task.status !== "done");
    const bootstrap = existingBootstrap ?? (await createTasks(workstream, [{ title: "Analyze the Workstream goal and coordinate the first actionable plan", ownerRole: policy.leadRole, acceptanceCriteria: ["The goal is decomposed into concrete Agent-owned tasks"] }]))[0];
    await createMessage(workstream, "human", [lead.id], action.content, action.messageType, bootstrap ? { taskId: bootstrap.id } : {});
  }
}

async function dispatchCollaboration(workstream: Workstream, roundId: string, dispatch: CollaborationDispatch, senderId: string): Promise<void> {
  const taskId = `${roundId}:task:${dispatch.key}`;
  let task = workstream.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    const now = new Date().toISOString();
    task = { id: taskId, workstreamId: workstream.id, title: `[Collaboration:${dispatch.stage}] ${dispatch.title}`, status: "assigned", ownerAgentId: dispatch.agentId, ...(senderId !== "human" ? { createdByAgentId: senderId } : {}), relatedTaskIds: [], acceptanceCriteria: ["Return one valid structured collaboration insight with auditable evidence"], dependencies: [], evidence: [], createdAt: now, updatedAt: now };
    workstream.tasks.push(task); await persistTask(task);
    emit(workstream, "task.created", `Collaboration task assigned: ${dispatch.title}`, dispatch.role);
  }
  await createMessage(workstream, senderId, [dispatch.agentId], dispatch.prompt, "request", { taskId, correlationId: roundId, causationId: roundId }, `${roundId}:message:${dispatch.key}`);
}

async function recoverDecomposition(
  workstream: Workstream,
  sender: Agent,
  envelope: { id?: string; correlationId?: string },
  failure?: { reason: string },
  resultText = "",
): Promise<void> {
  const attempt = decompositionReprompts.get(workstream.id) ?? 0;
  if (attempt < maxDecompositionReprompts) {
    const nextAttempt = attempt + 1;
    decompositionReprompts.set(workstream.id, nextAttempt);
    const latestTrigger = [...workstream.messages].reverse().find((message) =>
      message.content.includes(implementationTriggerMarker) && message.recipientIds.includes(sender.id)
    );
    let triggerContent = latestTrigger?.content;
    if (!triggerContent) {
      const insights = await insightRepository.listInsights(workstream.id);
      const synthesis = [...insights].reverse().find((candidate) => candidate.kind === "synthesis") ?? insights.at(-1);
      const synthesisText = synthesis?.content.slice(0, 2000) ?? "No collaboration synthesis was available.";
      const restOfInstruction = implementationTriggerInstruction(workstream.id).slice(
        "Decompose this into concrete implementation tasks.".length,
      );
      triggerContent = `${implementationTriggerMarker} The collaboration round is complete. Here is the agreed synthesis:\n\n${synthesisText}${implementationTriggerInstructionSeparator}${restOfInstruction}`;
    }
    const prefix = "Your previous reply did not contain a valid structured decomposition. Reply ONLY with one JSON object, with no markdown fences or prose. Set schemaVersion to 1, provide a summary string, empty insights and messages arrays, and between 1 and 12 implementation tasks. Every task must contain an id, a real non-placeholder title, an ownerRole from backend, frontend, pe, qa, or devops, and acceptanceCriteria as an array of strings. The platform appends final full-suite validation automatically. Do not write code yourself; delegate the work, and do not call any API.";
    const reprompt = await createMessage(workstream, "human", [sender.id], `${prefix}\n\n${triggerContent}`, "directive", {
      ...((latestTrigger?.id ?? envelope.id) ? { causationId: latestTrigger?.id ?? envelope.id } : {}),
    });
    if (reprompt.deliveryStatus !== "delivered") return;
    emit(workstream, "orchestration.decomposition_reprompted", `PM decomposition re-prompted (attempt ${nextAttempt})`, "human");
    await setAgentStatus(sender, "idle");
    return;
  }
  decompositionReprompts.delete(workstream.id);
  const detail = failure
    ? `The PM's turn failed or timed out: ${failure.reason}`
    : `The PM's last reply began:\n\n${JSON.stringify(resultText.slice(0, 500))}`;
  await createMessage(workstream, sender.id, ["human"], `Implementation decomposition failed after ${maxDecompositionReprompts} retries. ${detail}`, "decision", {
    ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}),
  });
  workstream.status = "waiting_for_human";
  emit(workstream, "orchestration.decomposition_failed", `PM decomposition failed after ${maxDecompositionReprompts} retries`, sender.role);
  await persistWorkstreamStatus(workstream);
  await setAgentStatus(sender, "idle");
}

async function handleWorkerResult(envelope: { id?: string; type: string; workstreamId: string; payload: unknown; correlationId?: string }): Promise<void> {
  if (["turn.started", "turn.delta", "turn.completed", "tool.started", "tool.completed", "turn.cancelled", "turn.failed", "usage.updated"].includes(envelope.type)) {
    const workstream = workstreams.get(envelope.workstreamId); if (!workstream) return;
    const payload = envelope.payload as { agentId?: string; taskId?: string; turnId?: string; text?: string; toolName?: string; output?: string; error?: { message?: string }; correlationId?: string; provider?: string; model?: string; usage?: ProviderUsage };
    if (envelope.type === "turn.started") dispatchWatchdog.clearForCorrelation(workstream.id, envelope.correlationId ?? payload.correlationId);
    const agent = payload.agentId ? workstream.agents.find((candidate) => candidate.id === payload.agentId) : undefined;
    const message = envelope.type === "turn.delta" ? payload.text ?? "" : envelope.type === "tool.started" ? `${payload.toolName ?? "tool"} started` : envelope.type === "tool.completed" ? `${payload.toolName ?? "tool"} completed` : envelope.type === "turn.failed" ? payload.error?.message ?? "Provider turn failed" : envelope.type === "usage.updated" ? "Provider usage updated" : envelope.type.replaceAll(".", " ");
    if (!message) return;
    const task = payload.taskId ? workstream.tasks.find((candidate) => candidate.id === payload.taskId) : undefined;
    const isActiveTurn = ["turn.started", "turn.delta", "tool.started", "tool.completed"].includes(envelope.type);
    if (agent && isActiveTurn) await setAgentStatus(agent, "running");
    if (agent && envelope.type === "turn.failed") await setAgentStatus(agent, "idle");
    if (task && isActiveTurn && !["done", "failed", "cancelled"].includes(task.status)) {
      task.status = "running";
      task.updatedAt = new Date().toISOString();
      await persistTask(task);
    }
    recordWorkflowEvent(workstream, { id: randomUUID(), type: envelope.type, message, occurredAt: new Date().toISOString(), ...(agent?.role ? { role: agent.role } : {}), ...(agent?.id ? { from: agent.id, agentId: agent.id } : {}), ...(payload.taskId ? { taskId: payload.taskId } : {}), ...(payload.toolName ? { toolName: payload.toolName } : {}), ...(payload.output ? { output: payload.output } : {}), ...(envelope.correlationId ?? payload.correlationId ? { correlationId: envelope.correlationId ?? payload.correlationId } : {}), ...(payload.provider ? { provider: payload.provider } : {}), ...(payload.model ? { model: payload.model } : {}), ...(payload.usage ? { usage: payload.usage } : {}) });
    return;
  }
  if (envelope.type === "run.started" || envelope.type === "run.heartbeat") {
    const workstream = workstreams.get(envelope.workstreamId); if (!workstream) return;
    const payload = envelope.payload as { agentId?: string; taskId?: string; elapsedMs?: number; provider?: string; model?: string; usage?: ProviderUsage };
    const role = payload.agentId ? workstream.agents.find((agent) => agent.id === payload.agentId)?.role : undefined;
    const agent = payload.agentId ? workstream.agents.find((candidate) => candidate.id === payload.agentId) : undefined;
    const task = payload.taskId ? workstream.tasks.find((candidate) => candidate.id === payload.taskId) : undefined;
    if (agent) await setAgentStatus(agent, "running");
    if (task && !["done", "failed", "cancelled"].includes(task.status)) {
      task.status = "running";
      task.updatedAt = new Date().toISOString();
      await persistTask(task);
    }
    recordWorkflowEvent(workstream, { id: randomUUID(), type: envelope.type, message: `${role ?? payload.agentId ?? "agent"} ${envelope.type === "run.heartbeat" ? `running (${Math.round((payload.elapsedMs ?? 0) / 1000)}s)` : "started"}`, occurredAt: new Date().toISOString(), ...(role ? { role } : {}), ...(payload.agentId ? { agentId: payload.agentId } : {}), ...(payload.taskId ? { taskId: payload.taskId } : {}), ...(payload.elapsedMs !== undefined ? { elapsedMs: payload.elapsedMs } : {}), ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}), ...(payload.provider ? { provider: payload.provider } : {}), ...(payload.model ? { model: payload.model } : {}), ...(payload.usage ? { usage: payload.usage } : {}) });
    return;
  }
  if (envelope.type !== "agent.turn.completed" && envelope.type !== "task.completed" && envelope.type !== "task.failed" && envelope.type !== "task.gated") return;
  app.log.info({ event: "worker.result.received", type: envelope.type, workstreamId: envelope.workstreamId, correlationId: envelope.correlationId }, "worker result received");
  const workstream = workstreams.get(envelope.workstreamId); if (!workstream) return;
  dispatchWatchdog.clearForCorrelation(workstream.id, envelope.correlationId);
  // The API can restart while a durable Worker turn is still in flight. Rebuild
  // the lightweight orchestration state from the persisted Workstream instead
  // of silently dropping that result.
  let orchestrator = orchestrators.get(envelope.workstreamId);
  if (!orchestrator) {
    orchestrator = new WorkstreamOrchestrator(workstream.id, workstream.goal, orchestrationPolicyFor(workstream));
    orchestrators.set(workstream.id, orchestrator);
  }
  const raw = envelope.payload as { agentId?: string; taskId?: string; text?: string; error?: string; evidenceIds?: string[]; provider?: string; model?: string; usage?: ProviderUsage; result?: { agentId?: string; taskId?: string; text?: string; error?: string; evidenceIds?: string[]; provider?: string; model?: string; usage?: ProviderUsage } };
  const payload = (raw.result ?? raw) as (typeof raw) & { structuredResult?: unknown; turnId?: string };
  dispatchWatchdog.clearForCorrelation(workstream.id, envelope.correlationId ?? (payload as { correlationId?: string }).correlationId);
  const sender = workstream.agents.find((candidate) => candidate.id === payload.agentId);
  if (!sender) { app.log.warn({ event: "worker.result.ignored", workstreamId: envelope.workstreamId, agentId: payload.agentId, taskId: payload.taskId, payloadKeys: Object.keys(raw) }, "worker result agent not found"); return; }
  const policy = orchestrationPolicyFor(workstream);
  const durableTask = payload.taskId ? workstream.tasks.find((candidate) => candidate.id === payload.taskId) : undefined;
  const triggerDecomposition = !durableTask && isImplementationTriggerResult({
    messages: workstream.messages.map((message) => ({ ...message, correlationId: message.correlationId ?? "" })),
    tasks: workstream.tasks,
    senderId: sender.id,
    senderRole: sender.role,
    leadRole: policy.leadRole,
    ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}),
  });
  if (envelope.type === "task.gated") {
    // A Human gate interrupted this execution. The task did not fail: return
    // it to assigned, close out its current delivery, and let activation
    // reconciliation re-drive it after the Human resumes.
    const task = durableTask;
    const reason = payload.error?.trim() || "execution held by a Human gate";
    if (task && !["done", "failed", "cancelled"].includes(task.status)) {
      task.status = "assigned";
      task.updatedAt = new Date().toISOString();
      await persistTask(task);
      for (const message of workstream.messages) {
        if (message.taskId !== task.id || !["pending", "delivered"].includes(message.deliveryStatus) || !message.recipientIds.includes(sender.id)) continue;
        const aggregateStatus = await messageRepository.updateDelivery(message.id, sender.id, "acknowledged");
        if (aggregateStatus) message.deliveryStatus = aggregateStatus;
      }
    }
    await setAgentStatus(sender, "idle");
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.gated", message: `${task?.title ?? sender.role} → ${reason}; task stays dispatchable and will be re-driven after resume`, occurredAt: new Date().toISOString(), role: sender.role, agentId: sender.id, ...(payload.taskId ? { taskId: payload.taskId } : {}), ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}), ...(payload.provider ? { provider: payload.provider } : {}), ...(payload.model ? { model: payload.model } : {}), ...(payload.usage ? { usage: payload.usage } : {}) });
    return;
  }
  if (envelope.type === "task.failed") {
    const task = durableTask;
    if (task) { task.status = "failed"; task.updatedAt = new Date().toISOString(); await persistTask(task); }
    const reason = payload.error?.trim() || "provider execution failed";
    if (triggerDecomposition) {
      recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.failed", message: `${sender.role} → ${reason}`, occurredAt: new Date().toISOString(), role: sender.role, agentId: sender.id, ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}), ...(payload.provider ? { provider: payload.provider } : {}), ...(payload.model ? { model: payload.model } : {}), ...(payload.usage ? { usage: payload.usage } : {}) });
      await recoverDecomposition(workstream, sender, envelope, { reason });
      return;
    }
    await setAgentStatus(sender, "idle");
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.failed", message: `${task?.title ?? sender.role} → ${reason}`, occurredAt: new Date().toISOString(), role: sender.role, agentId: sender.id, ...(payload.taskId ? { taskId: payload.taskId } : {}), ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}), ...(payload.provider ? { provider: payload.provider } : {}), ...(payload.model ? { model: payload.model } : {}), ...(payload.usage ? { usage: payload.usage } : {}) });
    if (task) await reconcileTaskDispatches(workstream);
    if (await reconcileCompletion(workstream)) return;
    workstream.status = "waiting_for_human";
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "workstream.waiting_for_human", message: "Provider execution failed; Human decision required", occurredAt: new Date().toISOString() });
    await persistWorkstreamStatus(workstream);
    return;
  }
  let triggerSpecs: TaskSpec[] | undefined;
  let triggerSummary: string | undefined;
  if (triggerDecomposition) {
    try {
      const result = parseStructuredTurn(payload.structuredResult);
      triggerSpecs = extractStructuredTaskSpecs(result);
      triggerSummary = result.summary.trim();
    } catch (error) {
      const reason = error instanceof InvalidStructuredTurn ? error.message : String(error);
      await recoverDecomposition(workstream, sender, envelope, { reason }, payload.text?.trim() ?? "");
      return;
    }
  }
  if (!triggerDecomposition && payload.structuredResult !== undefined) {
    try {
      let result = parseStructuredTurn(payload.structuredResult);
      // Real LLMs sometimes answer collaboration prompts with prose instead of the
      // required JSON contract. The worker then wraps the prose as a summary-only
      // result with zero insights, and without this fallback the collaboration
      // round never advances: no insight means advanceRound is never called and the
      // workstream sits "active" forever with no error. Wrap a substantive prose
      // summary as the stage's insight so the loop keeps moving with real content.
      const fallbackTask = workstream.tasks.find((task) => task.id === payload.taskId);
      const fallbackStage = fallbackTask ? collaborationStage(fallbackTask.title) : undefined;
      const fallbackSummary = result.summary.trim();
      if (fallbackStage && !hasStructuredActions(result) && fallbackSummary.length >= 40) {
        result = {
          ...result,
          insights: [
            {
              id: `${fallbackStage}-prose`,
              content: fallbackSummary,
              kind: fallbackStage,
              confidence: 0.5,
              references: [],
              contradictionOf: [],
              evidenceIds: [],
            },
          ],
          // A prose synthesis still needs human approval: without a
          // completionProposal the round completes but the workstream never
          // reaches waiting_for_human.
          ...(fallbackStage === "synthesis"
            ? {
                completionProposal: {
                  reason: fallbackSummary.slice(0, 500),
                  evidenceIds: [],
                },
              }
            : {}),
        };
      }
      if (hasStructuredActions(result)) {
        const sourceTask = workstream.tasks.find((task) => task.id === payload.taskId);
        const evidenceIds = [...new Set(payload.evidenceIds ?? [])];
        if (evidenceIds.some((id) => !/^\d+$/.test(id))) throw new InvalidStructuredTurn("Invalid evidence ID");
        const persistedCount = sourceTask ? await evidenceRepository.countMatching(sourceTask.id, evidenceIds) : 0;
        if (persistedCount !== evidenceIds.length || (sourceTask && workstream.workspaceRoot && !evidenceIds.length)) throw new InvalidStructuredTurn("Structured result evidence persistence incomplete");
        const planned = planStructuredTurn(result, { workstreamId: workstream.id, agentId: sender.id,
          turnId: payload.turnId ?? envelope.id ?? "", correlationId: envelope.correlationId ?? envelope.id ?? "",
          ...(sourceTask ? { taskId: sourceTask.id } : {}), agents: workstream.agents, tasks: workstream.tasks,
          insights: await insightRepository.listInsights(workstream.id), evidenceIds, now: new Date().toISOString() });
        const plan = await structuredTurnRepository.apply(planned);
        for (const task of plan.tasks) if (!workstream.tasks.some((item) => item.id === task.id)) workstream.tasks.push(task as Task);
        if (sourceTask) { sourceTask.status = plan.blocked ? "blocked" : "done"; sourceTask.evidence = plan.sourceEvidenceIds; sourceTask.updatedAt = plan.createdAt; }
        sender.status = "idle";
        if (plan.waitingForHuman) workstream.status = "waiting_for_human";
        if (sourceTask && collaborationStage(sourceTask.title)) {
          for (const insight of plan.insights) {
            const decision = await insightRepository.advanceRound(workstream.id, insight.id);
            const roundCompleted = decision.round.status === "completed";
            emit(workstream, roundCompleted ? "collaboration.round.completed" : "collaboration.turn.accepted", decision.reason, sender.role);
            const next = dispatchForDecision(decision, await insightRepository.listInsights(workstream.id), workstream.agents);
            if (next) await dispatchCollaboration(workstream, decision.round.id, next, sender.id);
            // After the collaboration round completes, automatically trigger the
            // implementation phase: prompt the PM lead to decompose the synthesis
            // into concrete implementation tasks through the native turn-result path.
            // Without this, the workstream stalls — the PM does not know to delegate.
            if (roundCompleted) {
              const policy = orchestrationPolicyFor(workstream);
              const lead = workstream.agents.find((candidate) => candidate.role === policy.leadRole);
              const synthesis = plan.insights.find((candidate) => candidate.kind === "synthesis") ?? plan.insights[plan.insights.length - 1];
              if (lead && synthesis) {
                if (implementationTriggerExists({ messages: workstream.messages, tasks: workstream.tasks, leadAgentId: lead.id })) {
                  emit(workstream, "orchestration.implementation_trigger_exists", "PM implementation trigger already exists", "human");
                } else {
                  const synthesisText = typeof synthesis.content === "string" ? synthesis.content.slice(0, 2000) : JSON.stringify(synthesis).slice(0, 2000);
                  const restOfInstruction = implementationTriggerInstruction(workstream.id).slice(
                    "Decompose this into concrete implementation tasks.".length,
                  );
                  const trigger = await createMessage(workstream, "human", [lead.id],
                    `${implementationTriggerMarker} The collaboration round is complete. Here is the agreed synthesis:\n\n${synthesisText}${implementationTriggerInstructionSeparator}${restOfInstruction}`,
                    "directive", {});
                  if (trigger.deliveryStatus === "delivered") {
                    emit(workstream, "orchestration.implementation_triggered", "PM prompted to decompose synthesis into implementation tasks", "human");
                  }
                }
              }
            }
          }
        }
        for (const message of plan.messages) {
          if (!workstream.messages.some((item) => item.id === message.id)) workstream.messages.push(message as Message);
          if (!shouldDispatchMessage(message.senderId, message.content)) {
            emit(workstream, "orchestration.agent_directive_suppressed", `Agent-authored implementation directive suppressed for message ${message.id}`, sender.role);
            const notification = JSON.stringify({ workstreamId: workstream.id, type: "message.created", message, occurredAt: message.createdAt });
            for (const socket of sockets) socket.send(notification);
            continue;
          }
          // A retry republishes stable message IDs; receiver execution keys suppress duplicates.
          for (const recipient of message.recipientIds) {
            try {
              await publishWithRetry(() => eventBus.publish(subjects.inbox.replace("*", recipient), {
                id: `${message.id}:${recipient}`, type: "message.created", workstreamId: workstream.id,
                correlationId: message.correlationId, causationId: plan.id, occurredAt: message.createdAt, payload: message,
              }));
              const policy = orchestrationPolicyFor(workstream);
              const lead = workstream.agents.find((agent) => agent.role === policy.leadRole);
              armDispatchWatchdogAfterPublish(workstream, message as Message, recipient, lead);
            } catch (error) {
              await messageRepository.updateDelivery(message.id, recipient, "failed");
              emit(workstream, "message.dispatch_failed", `Inbox dispatch failed for recipient ${recipient}, message ${message.id}`);
              app.log.error({ error, workstreamId: workstream.id, recipientId: recipient, messageId: message.id }, "message.dispatch_failed");
            }
          }
          const notification = JSON.stringify({ workstreamId: workstream.id, type: "message.created", message, occurredAt: message.createdAt });
          for (const socket of sockets) socket.send(notification);
        }
        const event: WorkflowEvent = { id: `${plan.id}:applied`, type: sourceTask ? (plan.blocked ? "task.blocked" : "task.completed") : "agent.turn.applied", message: plan.summary,
          ...(sourceTask ? { taskId: sourceTask.id } : {}),
          agentId: sender.id, role: sender.role, occurredAt: plan.createdAt, ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}),
          ...(payload.provider ? { provider: payload.provider } : {}), ...(payload.model ? { model: payload.model } : {}), ...(payload.usage ? { usage: payload.usage } : {}) };
        event.sequence = await workflowEventRepository.append(workstream.id, event);
        if (!workstream.events.some((item) => item.id === event.id)) workstream.events.push(event);
        for (const socket of sockets) socket.send(JSON.stringify({ workstreamId: workstream.id, ...event }));
        if (sourceTask?.status === "done") await reconcileTaskDispatches(workstream);
        await reconcileCompletion(workstream);
        return;
      }
    } catch (error) {
      // Any failure while applying a structured turn — an invalid shape OR a
      // collaboration-policy rejection — must go loud. Rethrowing here used to
      // leave the workstream "active" forever with no workflow event at all
      // (silent round deadlock), which is strictly worse than a visible error.
      const message = error instanceof Error ? error.message : String(error);
      app.log.warn({ event: "agent.turn.rejected", workstreamId: workstream.id, agentId: sender.id, error: message }, "Structured result rejected");
      if (["active", "starting"].includes(workstream.status)) {
        const sourceTask = workstream.tasks.find((task) => task.id === payload.taskId && task.ownerAgentId === sender.id);
        if (sourceTask && !["done", "failed", "cancelled"].includes(sourceTask.status)) {
          sourceTask.status = "failed"; sourceTask.updatedAt = new Date().toISOString(); await persistTask(sourceTask);
          await reconcileTaskDispatches(workstream);
        }
        await setAgentStatus(sender, "failed");
        workstream.status = "waiting_for_human";
        await persistWorkstreamStatus(workstream);
      }
      emit(workstream, "agent.turn.rejected", message, sender.role);
      return;
    }
  }
  const resultText = payload.text?.trim() ?? "";
  if (sender.role === policy.leadRole && resultText.startsWith("[HUMAN_BLOCKED]")) {
    const clarification = resultText.replace(/^\[HUMAN_BLOCKED\]\s*/i, "").trim();
    await createMessage(workstream, sender.id, ["human"], clarification, "clarification", { ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}) });
    workstream.status = "waiting_for_human";
    await setAgentStatus(sender, "idle");
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "workstream.human_blocked", message: clarification, occurredAt: new Date().toISOString(), role: sender.role });
    await persistWorkstreamStatus(workstream);
    return;
  }
  if (!resultText && !triggerDecomposition) {
    const task = payload.taskId ? workstream.tasks.find((candidate) => candidate.id === payload.taskId) : undefined;
    if (task) { task.status = "failed"; task.updatedAt = new Date().toISOString(); await persistTask(task); }
    await setAgentStatus(sender, "failed");
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.failed", message: `${task?.title ?? sender.role} → provider returned no text summary`, occurredAt: new Date().toISOString(), role: sender.role, ...(task ? { taskId: task.id } : {}) });
    if (task) await reconcileTaskDispatches(workstream);
    await reconcileCompletion(workstream);
    app.log.warn({ workstreamId: envelope.workstreamId, agentId: sender.id, taskId: payload.taskId }, "provider returned empty result");
    return;
  }
  // Worker execution IDs are not necessarily durable task IDs. Only a task
  // that exists in this Workstream may advance orchestration; all other turns
  // are direct Human ↔ Agent conversation and belong in the Intercom.
  // It must come back to the Intercom as a reply, rather than being interpreted
  // as an orchestration handoff or disappearing into lifecycle events.
  if (!durableTask && !triggerDecomposition) {
    await createMessage(workstream, sender.id, ["human"], resultText, "reply", { ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}) });
    await setAgentStatus(sender, "idle");
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "agent.reply.created", message: `${sender.role} replied to Human`, occurredAt: new Date().toISOString(), role: sender.role, agentId: sender.id, ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}) });
    return;
  }
  const task = durableTask;
  const qaMarker = resultText.split(/\r?\n/, 1)[0]?.trim().match(/^\[(QA_PASSED|QA_FAILED)\]/i)?.[1]?.toUpperCase();
  const completedTaskIds = task ? completedTaskIdsForPhaseResult(workstream.tasks, workstream.messages, {
    taskId: task.id,
    agentId: sender.id,
    ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}),
    reviewPassed: sender.role === policy.reviewRole && qaMarker === "QA_PASSED",
  }) : [];
  if (task && completedTaskIds.includes(task.id)) {
    const evidenceIds = [...new Set(payload.evidenceIds ?? [])];
    const persistedEvidenceCount = await evidenceRepository.countMatching(task.id, evidenceIds);
    if (workstream.workspaceRoot && (!evidenceIds.length || persistedEvidenceCount !== evidenceIds.length)) {
      task.status = "failed"; task.updatedAt = new Date().toISOString(); await setAgentStatus(sender, "failed"); await persistTask(task);
      recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.failed", message: `${task.title} → evidence persistence incomplete`, occurredAt: new Date().toISOString(), role: sender.role, taskId: task.id });
      await reconcileTaskDispatches(workstream);
      await reconcileCompletion(workstream);
      return;
    }
    task.status = "done"; task.evidence = [...new Set([...task.evidence, ...evidenceIds])]; task.updatedAt = new Date().toISOString(); await setAgentStatus(sender, "idle"); await persistTask(task); recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.completed", message: isFinalValidationTask(task) ? resultText : `${task.title} → done`, occurredAt: new Date().toISOString(), role: sender.role, agentId: sender.id, taskId: task.id, ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}), ...(payload.provider ? { provider: payload.provider } : {}), ...(payload.model ? { model: payload.model } : {}), ...(payload.usage ? { usage: payload.usage } : {}) });
  }
  for (const completedTaskId of completedTaskIds) {
    if (completedTaskId !== task?.id) {
      const reviewedTask = workstream.tasks.find((candidate) => candidate.id === completedTaskId);
      if (!reviewedTask || reviewedTask.status === "done") continue;
      reviewedTask.status = "done";
      reviewedTask.updatedAt = new Date().toISOString();
      await persistTask(reviewedTask);
      recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.completed", message: `${reviewedTask.title} → done after review`, occurredAt: new Date().toISOString(), role: sender.role, agentId: sender.id, taskId: reviewedTask.id, ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}) });
    }
  }
  if (completedTaskIds.length) await reconcileTaskDispatches(workstream);
  if (await reconcileCompletion(workstream)) return;
  const orchestrationText = triggerDecomposition ? triggerSummary ?? "" : resultText;
  if (triggerDecomposition) decompositionReprompts.delete(workstream.id);
  const eventType = sender.role === policy.leadRole ? "goal.received" : sender.role === policy.planningRole ? "task.decomposed" : policy.executionRoles.includes(sender.role) ? "design.completed" : qaMarker === "QA_PASSED" ? "qa.passed" : qaMarker === "QA_FAILED" ? "qa.failed" : /fail|missing|error/i.test(resultText) ? "qa.failed" : "qa.passed";
  const action = orchestrator.apply({ type: eventType, content: orchestrationText, ...(payload.evidenceIds ? { evidenceIds: payload.evidenceIds } : {}) });
  if (!action) { await setAgentStatus(sender, "idle"); workstream.status = "completed"; recordWorkflowEvent(workstream, { id: randomUUID(), type: "workstream.completed", message: "Orchestrator completed the workflow", occurredAt: new Date().toISOString() }); await persistWorkstreamStatus(workstream); return; }
  let handoffTaskId: string | undefined = payload.taskId;
  let dispatchContent = action.content;
  const leadAgent = workstream.agents.find((candidate) => candidate.role === policy.leadRole);
  const dispatchRecipient = workstream.agents.find((candidate) => candidate.role === action.recipientRole);
  const executionAgentIds = new Set(workstream.agents.filter((candidate) => policy.executionRoles.includes(candidate.role)).map((candidate) => candidate.id));
  const plannedTaskIds = new Set(workstream.tasks.filter((candidate) => candidate.createdByAgentId === leadAgent?.id).map((candidate) => candidate.id));
  const executionDispatches = workstream.messages.filter((message) =>
    message.taskId && plannedTaskIds.has(message.taskId) && message.recipientIds.some((recipientId) => executionAgentIds.has(recipientId))
  );
  const dispatchedPlannedTaskIds = new Set(executionDispatches.flatMap((message) => message.taskId ? [message.taskId] : []));
  const lastExecutedPlannedTaskId = executionDispatches.at(-1)?.taskId;
  const selectedExecutionTask = action.stage === "execution"
    ? selectPlannedTask(workstream.tasks, leadAgent?.id, {
        fixUp: eventType === "qa.failed",
        ...(lastExecutedPlannedTaskId ? { lastExecutedTaskId: lastExecutedPlannedTaskId } : {}),
        dispatchedTaskIds: dispatchedPlannedTaskIds,
      })
    : undefined;
  let handoffRecipientId: string | undefined;
  if (sender.role === policy.leadRole && action.recipientRole !== "human") {
    const specs = triggerDecomposition ? triggerSpecs! : extractTaskSpecs(orchestrationText);
    const decomposed = specs.length ? specs : [{ title: `Prepare the ${workstream.flavor} plan`, ownerRole: policy.planningRole }];
    if (decomposed[0] && !decomposed[0].ownerRole) decomposed[0] = { ...decomposed[0], ownerRole: action.recipientRole };
    const created = await createTasks(workstream, decomposed, sender.id);
    if (policy.executionRoles.includes(action.recipientRole)) {
      const selected = selectedExecutionTask ?? selectPlannedTask(workstream.tasks, leadAgent?.id, { fixUp: false, ...(dispatchRecipient ? { recipientAgentId: dispatchRecipient.id } : {}), dispatchedTaskIds: dispatchedPlannedTaskIds });
      handoffTaskId = selected?.id ?? created[0]?.id;
      if (selected) {
        const owner = workstream.agents.find((candidate) => candidate.id === selected.ownerAgentId && policy.executionRoles.includes(candidate.role));
        handoffRecipientId = owner?.id;
        const actionContent = owner ? action.content.replace(/recipient=[^\s\]]+/, `recipient=${owner.role}`) : action.content;
        dispatchContent = `${actionContent}\n\nPlanned task:\n${selected.title}\n\nAcceptance criteria:\n${selected.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`;
      }
    } else {
      handoffTaskId = created[0]?.id;
    }
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.decomposition.persisted", message: `${created.length} durable task${created.length === 1 ? "" : "s"} created from ${policy.leadRole} output`, occurredAt: new Date().toISOString(), role: sender.role });
  } else if (action.recipientRole !== "human") {
    const targetAgent = workstream.agents.find((candidate) => candidate.role === action.recipientRole);
    const ownerRole = targetAgent?.role;
    const parentTaskId = task?.id;
    if (targetAgent && ownerRole) {
      if (policy.executionRoles.includes(action.recipientRole)) {
        const selected = selectedExecutionTask ?? selectPlannedTask(workstream.tasks, leadAgent?.id, { fixUp: eventType === "qa.failed", recipientAgentId: targetAgent.id, ...(lastExecutedPlannedTaskId ? { lastExecutedTaskId: lastExecutedPlannedTaskId } : {}), dispatchedTaskIds: dispatchedPlannedTaskIds });
        if (selected) {
          handoffTaskId = selected.id;
          const owner = workstream.agents.find((candidate) => candidate.id === selected.ownerAgentId && policy.executionRoles.includes(candidate.role));
          handoffRecipientId = owner?.id;
          const actionContent = owner ? action.content.replace(/recipient=[^\s\]]+/, `recipient=${owner.role}`) : action.content;
          dispatchContent = `${actionContent}\n\nPlanned task:\n${selected.title}\n\nAcceptance criteria:\n${selected.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`;
        } else {
          const created = await createTasks(workstream, [{ title: deriveHandoffTitle(action.content, `Continue the ${workstream.flavor} workstream`), ownerRole, ...(parentTaskId ? { parentTaskId } : {}) }], sender.id);
          handoffTaskId = created[0]?.id;
        }
      } else {
        const executedTask = task && policy.executionRoles.includes(sender.role) ? task : undefined;
        const title = action.recipientRole === policy.reviewRole
          ? executedTask ? `Review: ${executedTask.title}` : "Review the implementation"
          : deriveHandoffTitle(action.content, `Continue the ${workstream.flavor} workstream`);
        const created = await createTasks(workstream, [{ title, ownerRole, ...(parentTaskId ? { parentTaskId } : {}), ...(executedTask ? { relatedTaskIds: [executedTask.id] } : {}) }], sender.id);
        handoffTaskId = created[0]?.id;
      }
    }
  }
  const recipient = action.recipientRole === "human" ? "human" : handoffRecipientId ?? workstream.agents.find((candidate) => candidate.role === action.recipientRole)?.id; if (!recipient) return;
  await createMessage(workstream, sender.id, [recipient], dispatchContent, action.messageType, { ...(handoffTaskId ? { taskId: handoffTaskId } : {}), ...(envelope.id ? { causationId: envelope.id } : {}), ...(payload.evidenceIds ? { evidenceIds: payload.evidenceIds } : {}) });
  await setAgentStatus(sender, "idle");
  if (action.recipientRole === "human") { workstream.status = "waiting_for_human"; recordWorkflowEvent(workstream, { id: randomUUID(), type: "workstream.waiting_for_human", message: "Human approval required before completion", occurredAt: new Date().toISOString() }); }
}

await app.listen({ host: "0.0.0.0", port: Number(process.env.CONTROL_API_PORT ?? 3000) });

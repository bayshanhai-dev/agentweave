import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { classifyHumanMessage } from "./message-intent.js";
import postgres from "postgres";
import { DeliverPolicy } from "nats";
import { extractTaskSpecs, WorkstreamOrchestrator, type OrchestrationDecision, type TaskSpec } from "./orchestrator.js";
import { JetStreamEventBus, subjects } from "@agentweave/protocol/jetstream";
import { runMigrations } from "./migrations.js";
import { WorkstreamCommandRepository } from "./repositories/workstream-command-repository.js";
import { WorkstreamRepository } from "./repositories/workstream-repository.js";
import { TaskRepository } from "./repositories/task-repository.js";
import { WorkflowEventRepository } from "./repositories/workflow-event-repository.js";
import { MessageRepository } from "./repositories/message-repository.js";
import { RuntimeRepository } from "./repositories/runtime-repository.js";
import { EvidenceRepository } from "./repositories/evidence-repository.js";
import { WorkstreamCommandError, WorkstreamLifecycleCommandHandler } from "./commands/workstream-lifecycle.js";

type Role = "pm" | "pe" | "coder" | "backend" | "frontend" | "qa" | "devops";
type ProviderUsage = { source: "provider" | "estimated" | "unknown"; inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number };
type WorkflowEvent = { id: string; sequence?: number; type: string; message: string; role?: Role; from?: string; to?: string; agentId?: string; taskId?: string; toolName?: string; output?: string; elapsedMs?: number; correlationId?: string; provider?: string; model?: string; usage?: ProviderUsage; occurredAt: string };
type Message = { id: string; workstreamId: string; senderId: string; recipientIds: string[]; messageType: string; content: string; taskId?: string; correlationId: string; causationId?: string; evidenceIds: string[]; createdAt: string; deliveryStatus: "pending" | "delivered" | "acknowledged" | "failed" };
type Agent = { id: string; role: Role; authority: "lead" | "reviewer" | "executor"; status: "idle" | "running" | "paused" | "stopped" | "failed" | "done"; orchestrator?: boolean };
type Task = { id: string; workstreamId: string; title: string; status: "ready" | "assigned" | "running" | "review" | "blocked" | "done" | "failed" | "cancelled"; ownerAgentId?: string; createdByAgentId?: string; parentTaskId?: string; relatedTaskIds: string[]; acceptanceCriteria: string[]; dependencies: string[]; evidence: string[]; createdAt: string; updatedAt: string };
type Workstream = { id: string; goal: string; flavor: string; status: string; provider: { tool: string; model: string }; workspaceRoot: string; agents: Agent[]; tasks: Task[]; events: WorkflowEvent[]; messages: Message[] };
const flavorTemplates = {
  "software-development": [
    { role: "pm", authority: "lead" }, { role: "pe", authority: "lead" },
    { role: "backend", authority: "executor" }, { role: "frontend", authority: "executor" },
    { role: "qa", authority: "reviewer" }, { role: "devops", authority: "executor" },
  ],
} as const;
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
const sql = postgres(process.env.DATABASE_URL ?? "postgres://agentweave:agentweave@localhost:5432/agentweave", { max: 5, connect_timeout: 10 });
const commandRepository = new WorkstreamCommandRepository(sql);
const workstreamRepository = new WorkstreamRepository(sql);
const taskRepository = new TaskRepository(sql);
const workflowEventRepository = new WorkflowEventRepository(sql);
const messageRepository = new MessageRepository(sql);
const runtimeRepository = new RuntimeRepository(sql);
const evidenceRepository = new EvidenceRepository(sql);
const lifecycleCommandHandler = new WorkstreamLifecycleCommandHandler(commandRepository);
const eventBus = new JetStreamEventBus({ url: process.env.NATS_URL ?? "nats://localhost:4222", durableName: "control-api-events-v4", deliverPolicy: DeliverPolicy.New });
const sockets = new Set<{ send: (data: string) => void }>();
const metrics = { requests: 0, workstreamsCreated: 0, runsStarted: 0, eventsEmitted: 0, workflowFailures: 0, providerInputTokens: 0, providerOutputTokens: 0, providerTotalTokens: 0, providerCostUsd: 0 };
type CommandBody = { commandId?: string; reason?: string; decision?: "resume" | "complete" | "reject" };

app.addHook("onRequest", async (request, reply) => {
  metrics.requests += 1;
  reply.header("access-control-allow-origin", "*");
  reply.header("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
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
app.get("/api/workstreams", async () => [...workstreams.values()]);
app.get("/api/workstreams/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const workstream = workstreams.get(id);
  return workstream ?? reply.code(404).send({ error: "workstream_not_found" });
});
app.get("/api/workstreams/:id/snapshot", async (request, reply) => {
  const { id } = request.params as { id: string };
  const workstream = workstreams.get(id);
  if (!workstream) return reply.code(404).send({ error: "workstream_not_found" });
  return { schemaVersion: 1, cursor: Math.max(0, ...workstream.events.map((event) => event.sequence ?? 0)), workstream };
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
    try { return await lifecycleCommandHandler.execute(workstream, command, body, (type, message) => emit(workstream, type, message)); }
    catch (error) { if (error instanceof WorkstreamCommandError) return reply.code(error.statusCode).send(error.body); throw error; }
  });
}
app.post("/api/workstreams/:id/approval", async (request, reply) => {
  const { id } = request.params as { id: string };
  const workstream = workstreams.get(id);
  const body = (request.body ?? {}) as CommandBody;
  if (!workstream) return reply.code(404).send({ error: "workstream_not_found" });
  try { return await lifecycleCommandHandler.approve(workstream, body, (type, message) => emit(workstream, type, message)); }
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
  await persistTask(task); emit(workstream, "task.updated", `${task.title} → ${task.status}`); return task;
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
  const humanToPm = body.from?.trim() === "human" && resolvedRecipients.some((recipient) => workstream.agents.find((agent) => agent.id === recipient)?.role === "pm");
  // A Human message to PM is an explicit resume signal while the Workstream is
  // waiting. Persist active before publishing the inbox message: otherwise the
  // Worker correctly sees waiting_for_human and acks the delivery without a turn.
  if (humanToPm && workstream.status === "waiting_for_human") {
    workstream.status = "active";
    orchestrators.set(workstream.id, new WorkstreamOrchestrator(workstream.id, workstream.goal));
    await persistWorkstreamStatus(workstream);
    emit(workstream, "workstream.resumed_by_human_message", "Human resumed the Workstream through PM");
  }
  let taskId = body.taskId;
  if (messageType === "request" && !taskId) {
    const now = new Date().toISOString();
    const pmOwner = humanToPm ? workstream.agents.find((agent) => agent.role === "pm") : undefined;
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
  const body = request.body as { goal?: string; flavor?: keyof typeof flavorTemplates; tool?: string; model?: string; workspaceRoot?: string } | undefined;
  if (!body?.goal?.trim()) return reply.code(400).send({ error: "goal_required" });
  const flavor = body.flavor ?? "software-development";
  if (!flavorTemplates[flavor]) return reply.code(400).send({ error: "unsupported_flavor", availableFlavors: Object.keys(flavorTemplates) });
  const id = randomUUID();
  const workstream: Workstream = {
    id, goal: body.goal.trim(), flavor, status: "draft",
    provider: { tool: body.tool ?? "mock", model: body.model ?? "deterministic" },
    workspaceRoot: body.workspaceRoot?.trim() || "/workspaces/agentweave", tasks: [], events: [], messages: [],
    agents: flavorTemplates[flavor].map((template, index) => ({ id: `${id}:${template.role}-${index + 1}`, role: template.role, authority: template.authority, status: "idle", ...(template.role === "pm" ? { orchestrator: true } : {}) })),
  };
  workstreams.set(id, workstream);
  await persistWorkstream(workstream);
  metrics.workstreamsCreated += 1;
  app.log.info({ workstreamId: id, flavor: workstream.flavor, provider: workstream.provider, workspaceRoot: workstream.workspaceRoot }, "workstream.created");
  emit(workstream, "workstream.created", "Software development hive created");
  return reply.code(201).send(workstream);
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
  const event: WorkflowEvent = { id: randomUUID(), type, message, occurredAt: new Date().toISOString(), ...(role ? { role } : {}) };
  recordWorkflowEvent(workstream, event);
  void eventBus.publish(subjects.events.replace("*", workstream.id), { id: event.id, type, workstreamId: workstream.id, occurredAt: event.occurredAt, payload: event });
}

function recordWorkflowEvent(workstream: Workstream, event: WorkflowEvent): void {
  event.sequence = Math.max(0, ...workstream.events.map((item) => item.sequence ?? 0)) + 1;
  workstream.events.push(event);
  void persistEvent(workstream.id, event);
  void persistWorkstreamStatus(workstream);
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
  const event: WorkflowEvent = { id: randomUUID(), sequence: Math.max(0, ...workstream.events.map((item) => item.sequence ?? 0)) + 1, type: "message.sent", message: content, from, to, occurredAt: new Date().toISOString() };
  workstream.events.push(event);
  await workflowEventRepository.append(workstream.id, { ...event, role: intent });
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
  message.deliveryStatus = "delivered";
  await messageRepository.markDelivered(message.id);
  emitMessage(workstream, "message.delivered", message);
  return message;
}

function emitMessage(workstream: Workstream, type: string, message: Message): void {
  const payload = JSON.stringify({ workstreamId: workstream.id, type, message, occurredAt: new Date().toISOString() });
  for (const socket of sockets) socket.send(payload);
  void eventBus.publish(subjects.events.replace("*", workstream.id), { id: `${message.id}:${type}`, type, workstreamId: workstream.id, occurredAt: message.createdAt, correlationId: message.correlationId, ...(message.causationId ? { causationId: message.causationId } : {}), payload: message });
  for (const recipientId of message.recipientIds) void eventBus.publish(subjects.inbox.replace("*", recipientId), { id: `${message.id}:${recipientId}`, type, workstreamId: workstream.id, occurredAt: message.createdAt, correlationId: message.correlationId, ...(message.causationId ? { causationId: message.causationId } : {}), payload: message });
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
  const created: Task[] = specs.map((spec) => {
    const owner = spec.ownerRole ? workstream.agents.find((agent) => agent.role === spec.ownerRole) : undefined;
    return {
      id: `${workstream.id}:task-${randomUUID()}`, workstreamId: workstream.id, title: spec.title.trim(), status: owner ? "assigned" : "ready",
      ...(owner ? { ownerAgentId: owner.id } : {}), ...(creatorAgentId ? { createdByAgentId: creatorAgentId } : {}),
      ...(spec.parentTaskId ? { parentTaskId: spec.parentTaskId } : {}), relatedTaskIds: spec.relatedTaskIds ?? [],
      acceptanceCriteria: spec.acceptanceCriteria?.length ? spec.acceptanceCriteria : ["Task is completed with evidence"],
      dependencies: spec.dependencies ?? [], evidence: [], createdAt: now, updatedAt: now,
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

async function persistEvent(workstreamId: string, event: WorkflowEvent): Promise<void> {
  await workflowEventRepository.append(workstreamId, event);
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
await eventBus.connect();
await loadWorkstreams();
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

async function startOrchestration(workstream: Workstream): Promise<void> {
  const orchestrator = new WorkstreamOrchestrator(workstream.id, workstream.goal); orchestrators.set(workstream.id, orchestrator);
  workstream.status = "active"; emit(workstream, "workstream.active", "Workflow started");
  const action = orchestrator.start(); const pm = workstream.agents.find((candidate) => candidate.role === "pm")!;
  const existingBootstrap = workstream.tasks.find((task) => task.ownerAgentId === pm.id && task.status !== "done");
  const bootstrap = existingBootstrap ?? (await createTasks(workstream, [{ title: "Analyze the Workstream goal and coordinate the first actionable plan", ownerRole: "pm", acceptanceCriteria: ["The goal is decomposed into concrete Agent-owned tasks"] }]))[0];
  await createMessage(workstream, "human", [pm.id], action.content, action.messageType, bootstrap ? { taskId: bootstrap.id } : {});
}

async function handleWorkerResult(envelope: { type: string; workstreamId: string; payload: unknown; correlationId?: string }): Promise<void> {
  if (["turn.started", "turn.delta", "turn.completed", "tool.started", "tool.completed", "turn.cancelled", "turn.failed", "usage.updated"].includes(envelope.type)) {
    const workstream = workstreams.get(envelope.workstreamId); if (!workstream) return;
    const payload = envelope.payload as { agentId?: string; taskId?: string; turnId?: string; text?: string; toolName?: string; output?: string; error?: { message?: string }; correlationId?: string; provider?: string; model?: string; usage?: ProviderUsage };
    const agent = payload.agentId ? workstream.agents.find((candidate) => candidate.id === payload.agentId) : undefined;
    const message = envelope.type === "turn.delta" ? payload.text ?? "" : envelope.type === "tool.started" ? `${payload.toolName ?? "tool"} started` : envelope.type === "tool.completed" ? `${payload.toolName ?? "tool"} completed` : envelope.type === "turn.failed" ? payload.error?.message ?? "Provider turn failed" : envelope.type === "usage.updated" ? "Provider usage updated" : envelope.type.replaceAll(".", " ");
    if (!message) return;
    const task = payload.taskId ? workstream.tasks.find((candidate) => candidate.id === payload.taskId) : undefined;
    const isActiveTurn = ["turn.started", "turn.delta", "tool.started", "tool.completed"].includes(envelope.type);
    if (agent && isActiveTurn) await setAgentStatus(agent, "running");
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
  if (envelope.type !== "agent.turn.completed" && envelope.type !== "task.completed" && envelope.type !== "task.failed") return;
  app.log.info({ event: "worker.result.received", type: envelope.type, workstreamId: envelope.workstreamId, correlationId: envelope.correlationId }, "worker result received");
  const workstream = workstreams.get(envelope.workstreamId); if (!workstream) return;
  // The API can restart while a durable Worker turn is still in flight. Rebuild
  // the lightweight orchestration state from the persisted Workstream instead
  // of silently dropping that result.
  let orchestrator = orchestrators.get(envelope.workstreamId);
  if (!orchestrator) {
    orchestrator = new WorkstreamOrchestrator(workstream.id, workstream.goal);
    orchestrators.set(workstream.id, orchestrator);
  }
  const raw = envelope.payload as { agentId?: string; taskId?: string; text?: string; error?: string; evidenceIds?: string[]; provider?: string; model?: string; usage?: ProviderUsage; result?: { agentId?: string; taskId?: string; text?: string; error?: string; evidenceIds?: string[]; provider?: string; model?: string; usage?: ProviderUsage } };
  const payload = raw.result ?? raw;
  const sender = workstream.agents.find((candidate) => candidate.id === payload.agentId);
  if (!sender) { app.log.warn({ event: "worker.result.ignored", workstreamId: envelope.workstreamId, agentId: payload.agentId, taskId: payload.taskId, payloadKeys: Object.keys(raw) }, "worker result agent not found"); return; }
  if (envelope.type === "task.failed") {
    const task = payload.taskId ? workstream.tasks.find((candidate) => candidate.id === payload.taskId) : undefined;
    if (task) { task.status = "failed"; task.updatedAt = new Date().toISOString(); await persistTask(task); }
    await setAgentStatus(sender, "failed");
    const reason = payload.error?.trim() || "provider execution failed";
    workstream.status = "waiting_for_human";
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.failed", message: `${task?.title ?? sender.role} → ${reason}`, occurredAt: new Date().toISOString(), role: sender.role, agentId: sender.id, ...(payload.taskId ? { taskId: payload.taskId } : {}), ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}), ...(payload.provider ? { provider: payload.provider } : {}), ...(payload.model ? { model: payload.model } : {}), ...(payload.usage ? { usage: payload.usage } : {}) });
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "workstream.waiting_for_human", message: "Provider execution failed; Human decision required", occurredAt: new Date().toISOString() });
    await persistWorkstreamStatus(workstream);
    return;
  }
  const resultText = payload.text?.trim() ?? "";
  if (sender.role === "pm" && resultText.startsWith("[HUMAN_BLOCKED]")) {
    const clarification = resultText.replace(/^\[HUMAN_BLOCKED\]\s*/i, "").trim();
    await createMessage(workstream, sender.id, ["human"], clarification, "clarification", { ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}) });
    workstream.status = "waiting_for_human";
    await setAgentStatus(sender, "idle");
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "workstream.human_blocked", message: clarification, occurredAt: new Date().toISOString(), role: sender.role });
    await persistWorkstreamStatus(workstream);
    return;
  }
  if (!resultText) {
    const task = payload.taskId ? workstream.tasks.find((candidate) => candidate.id === payload.taskId) : undefined;
    if (task) { task.status = "failed"; task.updatedAt = new Date().toISOString(); await persistTask(task); }
    await setAgentStatus(sender, "failed");
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.failed", message: `${task?.title ?? sender.role} → provider returned no text summary`, occurredAt: new Date().toISOString(), role: sender.role });
    app.log.warn({ workstreamId: envelope.workstreamId, agentId: sender.id, taskId: payload.taskId }, "provider returned empty result");
    return;
  }
  const durableTask = payload.taskId ? workstream.tasks.find((candidate) => candidate.id === payload.taskId) : undefined;
  // Worker execution IDs are not necessarily durable task IDs. Only a task
  // that exists in this Workstream may advance orchestration; all other turns
  // are direct Human ↔ Agent conversation and belong in the Intercom.
  // It must come back to the Intercom as a reply, rather than being interpreted
  // as an orchestration handoff or disappearing into lifecycle events.
  if (!durableTask) {
    await createMessage(workstream, sender.id, ["human"], resultText, "reply", { ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}) });
    await setAgentStatus(sender, "idle");
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "agent.reply.created", message: `${sender.role} replied to Human`, occurredAt: new Date().toISOString(), role: sender.role, agentId: sender.id, ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}) });
    return;
  }
  const task = durableTask;
  if (task && task.ownerAgentId === sender.id) {
    const evidenceIds = [...new Set(payload.evidenceIds ?? [])];
    const persistedEvidenceCount = await evidenceRepository.countMatching(task.id, evidenceIds);
    if (workstream.workspaceRoot && (!evidenceIds.length || persistedEvidenceCount !== evidenceIds.length)) {
      task.status = "failed"; task.updatedAt = new Date().toISOString(); await setAgentStatus(sender, "failed"); await persistTask(task);
      recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.failed", message: `${task.title} → evidence persistence incomplete`, occurredAt: new Date().toISOString(), role: sender.role });
      return;
    }
    task.status = "done"; task.evidence = [...new Set([...task.evidence, ...evidenceIds])]; task.updatedAt = new Date().toISOString(); await setAgentStatus(sender, "idle"); await persistTask(task); recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.completed", message: `${task.title} → done`, occurredAt: new Date().toISOString(), role: sender.role, agentId: sender.id, taskId: task.id, ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}), ...(payload.provider ? { provider: payload.provider } : {}), ...(payload.model ? { model: payload.model } : {}), ...(payload.usage ? { usage: payload.usage } : {}) });
  }
  if (sender.role === "pm" && resultText.startsWith("[PROPOSE_COMPLETE]")) {
    const proposal = resultText.replace(/^\[PROPOSE_COMPLETE\]\s*/i, "").trim();
    await createMessage(workstream, sender.id, ["human"], proposal || "PM proposes completion based on the attached evidence.", "decision", { ...(payload.taskId ? { taskId: payload.taskId } : {}), ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}), ...(payload.evidenceIds ? { evidenceIds: payload.evidenceIds } : {}) });
    workstream.status = "waiting_for_human";
    await setAgentStatus(sender, "idle");
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "workstream.completion_proposed", message: "PM proposed completion for Human review", occurredAt: new Date().toISOString(), role: sender.role, agentId: sender.id });
    await persistWorkstreamStatus(workstream);
    return;
  }
  const orchestrationText = sender.role === "pm" ? resultText.replace(/^\[READY_FOR_DECOMPOSITION\]\s*/i, "").trim() : resultText;
  const eventType = sender.role === "pm" ? "goal.received" : sender.role === "pe" ? "task.decomposed" : ["coder", "backend", "frontend"].includes(sender.role) ? "design.completed" : /fail|missing|error/i.test(resultText) ? "qa.failed" : "qa.passed";
  const action = orchestrator.apply({ type: eventType, content: orchestrationText, ...(payload.evidenceIds ? { evidenceIds: payload.evidenceIds } : {}) });
  if (!action) { await setAgentStatus(sender, "idle"); workstream.status = "completed"; recordWorkflowEvent(workstream, { id: randomUUID(), type: "workstream.completed", message: "Orchestrator completed the workflow", occurredAt: new Date().toISOString() }); await persistWorkstreamStatus(workstream); return; }
  let handoffTaskId: string | undefined = payload.taskId;
  if (sender.role === "pm" && action.recipientRole !== "human") {
    const specs = extractTaskSpecs(orchestrationText);
    const decomposed = specs.length ? specs : [{ title: "Refine the implementation plan for the Workstream goal", ownerRole: "pe" as Role }];
    if (decomposed[0] && !decomposed[0].ownerRole) decomposed[0] = { ...decomposed[0], ownerRole: action.recipientRole };
    const created = await createTasks(workstream, decomposed, sender.id);
    handoffTaskId = created[0]?.id;
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.decomposition.persisted", message: `${created.length} durable task${created.length === 1 ? "" : "s"} created from PM output`, occurredAt: new Date().toISOString(), role: sender.role });
  } else if (action.recipientRole !== "human") {
    const targetAgent = workstream.agents.find((candidate) => candidate.role === action.recipientRole) ?? (action.recipientRole === "coder" ? workstream.agents.find((candidate) => ["backend", "frontend"].includes(candidate.role)) : undefined);
    const ownerRole = targetAgent?.role;
    const parentTaskId = task?.id;
    if (targetAgent && ownerRole) {
      const created = await createTasks(workstream, [{ title: action.recipientRole === "qa" ? "Review implementation, tests, and evidence" : action.recipientRole === "coder" ? "Implement the approved design" : action.content.split("\n", 1)[0] ?? "Continue the Workstream", ownerRole, ...(parentTaskId ? { parentTaskId } : {}) }], sender.id);
      handoffTaskId = created[0]?.id;
    }
  }
  const recipient = action.recipientRole === "human" ? "human" : workstream.agents.find((candidate) => candidate.role === action.recipientRole)?.id ?? (action.recipientRole === "coder" ? workstream.agents.find((candidate) => ["backend", "frontend"].includes(candidate.role))?.id : undefined); if (!recipient) return;
  await createMessage(workstream, sender.id, [recipient], action.content, action.messageType, { ...(handoffTaskId ? { taskId: handoffTaskId } : {}), ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}), ...(payload.evidenceIds ? { evidenceIds: payload.evidenceIds } : {}) });
  await setAgentStatus(sender, "idle");
  if (action.recipientRole === "human") { workstream.status = "waiting_for_human"; recordWorkflowEvent(workstream, { id: randomUUID(), type: "workstream.waiting_for_human", message: "Human approval required before completion", occurredAt: new Date().toISOString() }); }
}

await app.listen({ host: "0.0.0.0", port: Number(process.env.CONTROL_API_PORT ?? 3000) });

import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { DeliverPolicy } from "nats";
import { canTransition, type WorkstreamStatus } from "@agentweave/domain";
import { WorkstreamOrchestrator, type OrchestrationDecision } from "./orchestrator.js";
import { JetStreamEventBus, subjects } from "@agentweave/protocol/jetstream";

type Role = "pm" | "pe" | "coder" | "backend" | "frontend" | "qa" | "devops";
type WorkflowEvent = { id: string; type: string; message: string; role?: Role; from?: string; to?: string; occurredAt: string };
type Message = { id: string; workstreamId: string; senderId: string; recipientIds: string[]; messageType: string; content: string; taskId?: string; correlationId: string; causationId?: string; evidenceIds: string[]; createdAt: string; deliveryStatus: "pending" | "delivered" | "acknowledged" | "failed" };
type Agent = { id: string; role: Role; authority: "lead" | "reviewer" | "executor"; status: "idle" | "running" | "paused" | "stopped" | "done"; orchestrator?: boolean };
type Task = { id: string; workstreamId: string; title: string; status: "ready" | "assigned" | "running" | "review" | "blocked" | "done" | "failed" | "cancelled"; ownerAgentId?: string; acceptanceCriteria: string[]; dependencies: string[]; evidence: string[]; createdAt: string; updatedAt: string };
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
const eventBus = new JetStreamEventBus({ url: process.env.NATS_URL ?? "nats://localhost:4222", durableName: "control-api-events-v4", deliverPolicy: DeliverPolicy.New });
const sockets = new Set<{ send: (data: string) => void }>();
const metrics = { requests: 0, workstreamsCreated: 0, runsStarted: 0, eventsEmitted: 0, workflowFailures: 0 };
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
  return Object.entries(metrics).map(([name, value]) => `agentweave_${name} ${value}`).join("\n") + "\n";
});
app.post("/api/runtime/workers/register", async (request, reply) => {
  const body = request.body as { workerId?: string; provider?: string; providerModel?: string; endpoint?: string | null; roles?: string[]; capabilities?: string[] } | undefined;
  if (!body?.workerId?.trim()) return reply.code(400).send({ error: "worker_id_required" });
  await sql`insert into runtime_workers (id, provider, provider_model, endpoint, roles, capabilities, status, last_heartbeat_at) values (${body.workerId.trim()}, ${body.provider ?? "unknown"}, ${body.providerModel ?? "default"}, ${body.endpoint ?? null}, ${body.roles ?? []}, ${body.capabilities ?? []}, 'online', now()) on conflict (id) do update set provider=excluded.provider, provider_model=excluded.provider_model, endpoint=excluded.endpoint, roles=excluded.roles, capabilities=excluded.capabilities, status='online', last_heartbeat_at=now()`;
  return { workerId: body.workerId.trim(), status: "online" };
});
app.post("/api/runtime/workers/:workerId/heartbeat", async (request, reply) => {
  const workerId = (request.params as { workerId: string }).workerId;
  const result = await sql`update runtime_workers set status='online', last_heartbeat_at=now(), current_task_id=${(request.body as { taskId?: string } | undefined)?.taskId ?? null} where id=${workerId} returning id`;
  return result.length ? { workerId, status: "online" } : reply.code(404).send({ error: "worker_not_registered" });
});
app.get("/api/workstreams", async () => [...workstreams.values()]);
app.get("/api/workstreams/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const workstream = workstreams.get(id);
  return workstream ?? reply.code(404).send({ error: "workstream_not_found" });
});
app.get("/api/workstreams/:id/tasks", async (request, reply) => {
  const { id } = request.params as { id: string }; const workstream = workstreams.get(id);
  return workstream ? workstream.tasks : reply.code(404).send({ error: "workstream_not_found" });
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
      const now = new Date().toISOString();
      const task: Task = { id: `${workstream.id}:orchestration-${randomUUID()}`, workstreamId: id, title: decision.taskTitle!, status: "ready", acceptanceCriteria: ["Task is completed with evidence"], dependencies: [], evidence: [], createdAt: now, updatedAt: now };
      workstream.tasks.push(task); taskId = task.id; await persistTask(task);
      emit(workstream, "task.created", `PM Lead created task for ${target.role}: ${task.title}`, "pm");
    }
    await createMessage(workstream, pm.id, [target.id], decision.content ?? decision.taskTitle!, "request", { ...(taskId ? { taskId } : {}) });
    emit(workstream, "orchestration.decision.applied", decision.reason, "pm");
  }
  return { accepted: true, workstreamId: id, decision };
});
for (const [command, target] of Object.entries({ pause: "paused", resume: "active", complete: "completed", "emergency-stop": "emergency_stopped", "waiting-for-human": "waiting_for_human" } as const)) {
  app.post(`/api/workstreams/:id/${command}`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const workstream = workstreams.get(id);
    const body = (request.body ?? {}) as CommandBody;
    if (!workstream) return reply.code(404).send({ error: "workstream_not_found" });
    if (["completing", "completed", "archived", "emergency_stopped"].includes(workstream.status)) return reply.code(409).send({ error: "workstream_not_actionable", status: workstream.status });
    if (["completing", "completed", "archived", "emergency_stopped"].includes(workstream.status)) return reply.code(409).send({ error: "workstream_not_actionable", status: workstream.status });
    const commandId = body.commandId?.trim() || randomUUID();
    const existing = await sql`select response from workstream_commands where workstream_id = ${id} and command_id = ${commandId}`;
    if (existing.length) return existing[0]!.response;
    const current = workstream.status as WorkstreamStatus;
    const transitionTarget: WorkstreamStatus = command === "pause" ? "pausing" : command === "resume" ? "resuming" : command === "complete" ? "completing" : target;
    const emergencyStop = command === "emergency-stop" && current !== "archived";
    if (!emergencyStop && !canTransition(current, transitionTarget)) return reply.code(409).send({ error: "invalid_workstream_transition", from: current, to: target });
    if (command === "pause") {
      workstream.status = "pausing";
      emit(workstream, "workstream.pausing", body.reason?.trim() || "Pause requested");
      workstream.status = "paused";
    } else if (command === "resume") {
      workstream.status = "resuming";
      emit(workstream, "workstream.resuming", body.reason?.trim() || "Resume requested");
      workstream.status = "active";
    } else if (command === "complete") {
      workstream.status = "completing";
      emit(workstream, "workstream.completing", body.reason?.trim() || "Completion requested");
      workstream.status = "completed";
    } else {
      workstream.status = target;
    }
    if (command === "pause" || command === "waiting-for-human") workstream.agents.forEach((agent) => { if (agent.status === "running" || agent.status === "idle") agent.status = "paused"; });
    if (command === "emergency-stop") workstream.agents.forEach((agent) => { if (agent.status !== "done") agent.status = "stopped"; });
    if (command === "complete") workstream.agents.forEach((agent) => { agent.status = "done"; });
    if (target === "active") workstream.agents.forEach((agent) => { if (agent.status !== "done" && agent.status !== "stopped") agent.status = "idle"; });
    const eventType = command === "emergency-stop" ? "workstream.emergency_stopped" : `workstream.${command.replaceAll("-", "_")}`;
    emit(workstream, eventType, body.reason?.trim() || `Workstream ${command.replaceAll("-", " ")} requested`);
    await persistWorkstreamStatus(workstream);
    const response = { commandId, workstreamId: id, command, status: workstream.status, accepted: true };
    await sql`insert into workstream_commands (workstream_id, command_id, command, response) values (${id}, ${commandId}, ${command}, ${JSON.stringify(response)})`;
    return response;
  });
}
app.post("/api/workstreams/:id/approval", async (request, reply) => {
  const { id } = request.params as { id: string };
  const workstream = workstreams.get(id);
  const body = (request.body ?? {}) as CommandBody;
  if (!workstream) return reply.code(404).send({ error: "workstream_not_found" });
  if (body.decision !== "resume" && body.decision !== "complete" && body.decision !== "reject") return reply.code(400).send({ error: "decision_required" });
  const commandId = body.commandId?.trim() || randomUUID();
  const existing = await sql`select response from workstream_commands where workstream_id = ${id} and command_id = ${commandId}`;
  if (existing.length) return existing[0]!.response;
  const target: WorkstreamStatus = body.decision === "resume" ? "active" : body.decision === "complete" ? "completed" : "paused";
  const validationTarget: WorkstreamStatus = body.decision === "complete" ? (workstream.status === "completing" ? "waiting_for_human" : "completing") : body.decision === "reject" ? "pausing" : target;
  if (!canTransition(workstream.status as WorkstreamStatus, validationTarget)) return reply.code(409).send({ error: "invalid_workstream_transition", from: workstream.status, to: target });
  if (body.decision === "complete") {
    workstream.status = "completing";
    emit(workstream, "approval.complete", body.reason?.trim() || "Human approval: complete");
    workstream.status = "completed";
  } else if (body.decision === "reject") {
    workstream.status = "pausing";
    emit(workstream, "approval.reject", body.reason?.trim() || "Human approval rejected");
    workstream.status = "paused";
  } else {
    workstream.status = target;
    emit(workstream, `approval.${body.decision}`, body.reason?.trim() || `Human approval: ${body.decision}`);
  }
  await persistWorkstreamStatus(workstream);
  const response = { commandId, workstreamId: id, command: "approval", decision: body.decision, status: target, accepted: true };
  await sql`insert into workstream_commands (workstream_id, command_id, command, response) values (${id}, ${commandId}, ${JSON.stringify(body.decision)}, ${JSON.stringify(response)})`;
  return response;
});
app.get("/api/workstreams/:id/agents/:agentId/inbox", async (request, reply) => {
  const { id, agentId } = request.params as { id: string; agentId: string };
  if (!workstreams.has(id)) return reply.code(404).send({ error: "workstream_not_found" });
  const rows = await sql`select m.*, d.delivery_status as recipient_delivery_status from messages m join message_deliveries d on d.message_id = m.id where m.workstream_id = ${id} and d.recipient_id = ${agentId} order by m.created_at asc`;
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
  const slashType = body.content.trim().match(/^\/(question|request|directive|decision)\b/i)?.[1]?.toLowerCase();
  const content = body.content.trim().replace(/^\/(question|request|directive|decision)\b\s*/i, "");
  const messageType = slashType || body.intent || "question";
  if (!["question", "request", "directive", "decision"].includes(messageType)) return reply.code(400).send({ error: "invalid_human_message_type", hint: "Use the Workstream control API for pause, resume, complete, or emergency stop." });
  let taskId = body.taskId;
  if (messageType === "request" && !taskId) {
    const now = new Date().toISOString();
    const task: Task = { id: `${workstream.id}:human-${randomUUID()}`, workstreamId: workstream.id, title: content, status: "ready", acceptanceCriteria: ["Human request is addressed and evidence is attached"], dependencies: [], evidence: [], createdAt: now, updatedAt: now };
    workstream.tasks.push(task);
    await persistTask(task);
    emit(workstream, "task.created", `Human request queued: ${task.title}`);
    taskId = task.id;
  }
  const message = await createMessage(workstream, body.from?.trim() || "human", resolvedRecipients, content, messageType, { ...body, ...(taskId ? { taskId } : {}) }, body.id);
  if (body.from?.trim() === "human" && resolvedRecipients.some((recipient) => workstream.agents.find((agent) => agent.id === recipient)?.role === "pm")) {
    const orchestrator = orchestrators.get(workstream.id);
    if (orchestrator?.stage === "waiting_for_human") {
      const action = orchestrator.apply({ type: "human.clarification.replied", content });
      workstream.status = "active";
      emit(workstream, "workstream.clarification_received", "Human clarification received by PM");
      if (action) { const pm = workstream.agents.find((agent) => agent.role === "pm"); if (pm) await createMessage(workstream, "human", [pm.id], action.content, action.messageType, { correlationId: message.correlationId, causationId: message.id }); }
      await persistWorkstreamStatus(workstream);
    }
  }
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
  const task: Task = { id: `${id}:task-1`, workstreamId: id, title: "Implement the highest-impact improvement", status: "ready", acceptanceCriteria: ["Implementation is scoped to the Workstream goal", "Relevant checks and tests pass", "Evidence is attached for review"], dependencies: [], evidence: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  workstream.tasks.push(task);
  workstreams.set(id, workstream);
  await persistWorkstream(workstream); await persistTask(task);
  metrics.workstreamsCreated += 1;
  app.log.info({ workstreamId: id, flavor: workstream.flavor, provider: workstream.provider, workspaceRoot: workstream.workspaceRoot }, "workstream.created");
  emit(workstream, "workstream.created", "Software development hive created");
  return reply.code(201).send(workstream);
});
app.get("/events", { websocket: true }, async (socket, request) => {
  sockets.add(socket);
  socket.send(JSON.stringify({ type: "system.connected", occurredAt: new Date().toISOString() }));
  const after = (request.query as { after?: string } | undefined)?.after;
  if (after) {
    const rows = await sql`select m.* from messages m where m.created_at > ${after} order by m.created_at asc`;
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
  workstream.events.push(event);
  void persistEvent(workstream.id, event);
  void persistWorkstreamStatus(workstream);
  metrics.eventsEmitted += 1;
  if (event.type === "run.started") metrics.runsStarted += 1;
  app.log.info({ workstreamId: workstream.id, eventId: event.id, eventType: event.type, role: event.role }, "workflow.event");
  const payload = JSON.stringify({ workstreamId: workstream.id, ...event });
  for (const socket of sockets) socket.send(payload);
}

async function createMessageEvent(workstream: Workstream, from: string, to: string, content: string, intent: string): Promise<WorkflowEvent> {
  const event: WorkflowEvent = { id: randomUUID(), type: "message.sent", message: content, from, to, occurredAt: new Date().toISOString() };
  workstream.events.push(event);
  await sql`insert into workflow_events (id, workstream_id, type, message, role, from_node, to_node, occurred_at)
    values (${event.id}, ${workstream.id}, ${event.type}, ${content}, ${intent}, ${from}, ${to}, ${event.occurredAt})`;
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
    const persisted = await sql`select id, workstream_id, sender_id, recipient_ids, message_type, content, task_id, correlation_id, causation_id, evidence_ids, created_at, delivery_status from messages where id = ${requestedId} and workstream_id = ${workstream.id}`;
    if (persisted.length) {
      const row = persisted[0]!;
      const restored: Message = { id: String(row.id), workstreamId: String(row.workstream_id), senderId: String(row.sender_id), recipientIds: row.recipient_ids as string[], messageType: String(row.message_type), content: String(row.content), ...(row.task_id ? { taskId: String(row.task_id) } : {}), correlationId: String(row.correlation_id), ...(row.causation_id ? { causationId: String(row.causation_id) } : {}), evidenceIds: row.evidence_ids as string[], createdAt: new Date(String(row.created_at)).toISOString(), deliveryStatus: String(row.delivery_status) as Message["deliveryStatus"] };
      workstream.messages.push(restored);
      return restored;
    }
  }
  const message: Message = { id: requestedId ?? randomUUID(), workstreamId: workstream.id, senderId, recipientIds, messageType, content, ...(extra.taskId ? { taskId: extra.taskId } : {}), correlationId: extra.correlationId ?? randomUUID(), ...(extra.causationId ? { causationId: extra.causationId } : {}), evidenceIds: extra.evidenceIds ?? [], createdAt: now, deliveryStatus: "pending" };
  await sql`insert into messages (id, workstream_id, sender_id, recipient_ids, message_type, content, task_id, correlation_id, causation_id, evidence_ids, created_at, delivery_status)
    values (${message.id}, ${message.workstreamId}, ${message.senderId}, ${message.recipientIds}, ${message.messageType}, ${message.content}, ${message.taskId ?? null}, ${message.correlationId}, ${message.causationId ?? null}, ${JSON.stringify(message.evidenceIds)}, ${message.createdAt}, ${message.deliveryStatus})`;
  workstream.messages.push(message);
  await sql`insert into message_deliveries ${sql(message.recipientIds.map((recipientId) => ({ message_id: message.id, recipient_id: recipientId, delivery_status: "pending" })))} on conflict do nothing`;
  emitMessage(workstream, "message.created", message);
  message.deliveryStatus = "delivered";
  await sql`update message_deliveries set delivery_status = 'delivered', delivered_at = now() where message_id = ${message.id}`;
  await sql`update messages set delivery_status = ${message.deliveryStatus} where id = ${message.id}`;
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
  await sql`update message_deliveries set delivery_status = ${status}, delivered_at = coalesce(delivered_at, now()) where message_id = ${messageId} and recipient_id = ${body.recipientId}`;
  const message = workstream.messages.find((candidate) => candidate.id === messageId)!;
  if (status === "failed") message.deliveryStatus = "failed";
  else {
    const pending = await sql`select 1 from message_deliveries where message_id = ${messageId} and delivery_status <> 'acknowledged' limit 1`;
    if (!pending.length) message.deliveryStatus = "acknowledged";
  }
  await sql`update messages set delivery_status = ${message.deliveryStatus} where id = ${messageId}`;
  emitMessage(workstream, status === "acknowledged" ? "message.acknowledged" : "message.failed", message);
  return { ...message, recipientId: body.recipientId };
}

async function persistWorkstream(workstream: Workstream): Promise<void> {
  await sql`insert into workstreams (id, goal, flavor, status, tool, model, workspace_root)
    values (${workstream.id}, ${workstream.goal}, ${workstream.flavor}, ${workstream.status}, ${workstream.provider.tool}, ${workstream.provider.model}, ${workstream.workspaceRoot})`;
  for (const agent of workstream.agents) {
    await sql`insert into agents (id, workstream_id, role, authority, status)
      values (${agent.id}, ${workstream.id}, ${agent.role}, ${agent.authority}, ${agent.status})`;
  }
}

async function persistTask(task: Task): Promise<void> {
  await sql`insert into tasks (id, workstream_id, title, status, owner_agent_id, acceptance_criteria, dependencies, evidence, created_at, updated_at)
    values (${task.id}, ${task.workstreamId}, ${task.title}, ${task.status}, ${task.ownerAgentId ?? null}, ${JSON.stringify(task.acceptanceCriteria)}, ${JSON.stringify(task.dependencies)}, ${JSON.stringify(task.evidence)}, ${task.createdAt}, ${task.updatedAt})
    on conflict (id) do update set status = excluded.status, owner_agent_id = excluded.owner_agent_id, evidence = excluded.evidence, updated_at = excluded.updated_at`;
}

async function persistWorkstreamStatus(workstream: Workstream): Promise<void> {
  await sql`update workstreams set status = ${workstream.status}, updated_at = now() where id = ${workstream.id}`;
  for (const agent of workstream.agents) {
    await sql`update agents set status = ${agent.status} where id = ${agent.id}`;
  }
}

async function persistEvent(workstreamId: string, event: WorkflowEvent): Promise<void> {
  await sql`insert into workflow_events (id, workstream_id, type, message, role, from_node, to_node, occurred_at)
    values (${event.id}, ${workstreamId}, ${event.type}, ${event.message}, ${event.role ?? null}, ${event.from ?? null}, ${event.to ?? null}, ${event.occurredAt})`;
}

async function loadWorkstreams(): Promise<void> {
  const rows = await sql`select id, goal, flavor, status, tool, model, workspace_root from workstreams order by created_at desc`;
  for (const row of rows) {
    const agents = await sql`select id, role, authority, status from agents where workstream_id = ${row.id} order by id`;
    const tasks = await sql`select id, workstream_id, title, status, owner_agent_id, acceptance_criteria, dependencies, evidence, created_at, updated_at from tasks where workstream_id = ${row.id} order by created_at asc`;
    const events = await sql`select id, type, message, role, from_node, to_node, occurred_at from workflow_events where workstream_id = ${row.id} order by occurred_at asc`;
    const loadedTasks = tasks.map((task) => ({ id: String(task.id), workstreamId: String(task.workstream_id), title: String(task.title), status: String(task.status) as Task["status"], ...(task.owner_agent_id ? { ownerAgentId: String(task.owner_agent_id) } : {}), acceptanceCriteria: jsonArray(task.acceptance_criteria), dependencies: jsonArray(task.dependencies), evidence: jsonArray(task.evidence), createdAt: new Date(String(task.created_at)).toISOString(), updatedAt: new Date(String(task.updated_at)).toISOString() }));
    if (!loadedTasks.length) {
      const task: Task = { id: `${row.id}:task-1`, workstreamId: String(row.id), title: "Review and continue the Workstream", status: "ready", acceptanceCriteria: ["Work remains scoped to the Workstream goal", "Relevant checks pass", "Evidence is attached before review"], dependencies: [], evidence: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      loadedTasks.push(task); await persistTask(task);
    }
    const normalizedStatus = normalizeLoadedStatus(String(row.status), events.map((event) => ({ type: event.type })));
    workstreams.set(String(row.id), {
      id: String(row.id), goal: String(row.goal), flavor: String(row.flavor), status: normalizedStatus,
      provider: { tool: String(row.tool), model: String(row.model) }, workspaceRoot: String(row.workspace_root),
      tasks: loadedTasks,
      agents: agents.map((agent) => ({ id: String(agent.id), role: String(agent.role) as Role, authority: String(agent.authority) as Agent["authority"], status: String(agent.status) as Agent["status"] })),
      messages: [],
      events: events.map((event) => ({ id: String(event.id), type: String(event.type), message: String(event.message), ...(event.role && ["pm", "pe", "coder", "qa"].includes(String(event.role)) ? { role: String(event.role) as Role } : {}), ...(event.from_node ? { from: String(event.from_node) } : {}), ...(event.to_node ? { to: String(event.to_node) } : {}), occurredAt: new Date(String(event.occurred_at)).toISOString() })),
    });
    if (normalizedStatus !== String(row.status)) await sql`update workstreams set status = ${normalizedStatus}, updated_at = now() where id = ${row.id}`;
    const messages = await sql`select id, workstream_id, sender_id, recipient_ids, message_type, content, task_id, correlation_id, causation_id, evidence_ids, created_at, delivery_status from messages where workstream_id = ${row.id} order by created_at asc`;
    workstreams.get(String(row.id))!.messages = messages.map((m) => ({ id: String(m.id), workstreamId: String(m.workstream_id), senderId: String(m.sender_id), recipientIds: m.recipient_ids as string[], messageType: String(m.message_type), content: String(m.content), ...(m.task_id ? { taskId: String(m.task_id) } : {}), correlationId: String(m.correlation_id), ...(m.causation_id ? { causationId: String(m.causation_id) } : {}), evidenceIds: m.evidence_ids as string[], createdAt: new Date(String(m.created_at)).toISOString(), deliveryStatus: String(m.delivery_status) as Message["deliveryStatus"] }));
  }
  app.log.info({ workstreamCount: workstreams.size }, "workstreams.loaded");
}

await sql`create table if not exists workstreams (id text primary key, goal text not null, flavor text not null, status text not null, tool text not null, model text not null, workspace_root text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
await sql`create table if not exists tasks (id text primary key, workstream_id text not null references workstreams(id) on delete cascade, title text not null, status text not null, owner_agent_id text, acceptance_criteria jsonb not null default '[]', dependencies jsonb not null default '[]', evidence jsonb not null default '[]', created_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
await sql`create table if not exists agents (id text primary key, workstream_id text not null references workstreams(id) on delete cascade, role text not null, authority text not null, status text not null)`;
await sql`create table if not exists workflow_events (id text primary key, workstream_id text not null references workstreams(id) on delete cascade, type text not null, message text not null, role text, from_node text, to_node text, occurred_at timestamptz not null)`;
await sql`create table if not exists messages (id text primary key, workstream_id text not null references workstreams(id) on delete cascade, sender_id text not null, recipient_ids text[] not null, message_type text not null, content text not null, task_id text, correlation_id text not null, causation_id text, evidence_ids jsonb not null default '[]', created_at timestamptz not null default now(), delivery_status text not null default 'pending')`;
await sql`create table if not exists message_deliveries (message_id text not null references messages(id) on delete cascade, recipient_id text not null, delivery_status text not null default 'pending', delivered_at timestamptz, primary key (message_id, recipient_id))`;
await sql`create table if not exists workstream_commands (workstream_id text not null references workstreams(id) on delete cascade, command_id text not null, command text not null, response jsonb not null, created_at timestamptz not null default now(), primary key (workstream_id, command_id))`;
await sql`create table if not exists agent_sessions (id text primary key, agent_id text not null, provider text not null, provider_session_id text not null, status text not null, current_turn_id text, last_checkpoint jsonb, last_event_sequence integer not null default 0, worker_id text, lease_expires_at timestamptz, updated_at timestamptz not null default now())`;
await sql`create table if not exists task_execution_claims (task_id text primary key, workstream_id text, worker_id text not null, message_id text not null, status text not null default 'active', started_at timestamptz not null default now(), finished_at timestamptz, lease_expires_at timestamptz not null)`;
await sql`create index if not exists task_execution_claims_lease_idx on task_execution_claims(status, lease_expires_at)`;
await sql`create table if not exists workspace_evidence (id bigserial primary key, task_id text not null references tasks(id) on delete cascade, workspace_path text not null, git_diff text not null, test_command text, test_output text, test_exit_code integer, created_at timestamptz not null default now())`;
await sql`alter table workspace_evidence add column if not exists kind text not null default 'workspace'`;
await sql`alter table workspace_evidence add column if not exists warnings jsonb not null default '[]'`;
await sql`create table if not exists runtime_workers (id text primary key, provider text not null, roles text[] not null default '{}', capabilities text[] not null default '{}', status text not null default 'offline', current_task_id text, last_heartbeat_at timestamptz, registered_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
await sql`alter table runtime_workers add column if not exists provider_model text not null default 'default'`;
await sql`alter table runtime_workers add column if not exists endpoint text`;
await sql`create index if not exists runtime_workers_heartbeat_idx on runtime_workers(status, last_heartbeat_at)`;
await sql`create index if not exists agent_sessions_lease_idx on agent_sessions(status, lease_expires_at)`;
await sql`create index if not exists messages_workstream_created_idx on messages(workstream_id, created_at)`;
await sql`create index if not exists messages_recipient_idx on messages using gin(recipient_ids)`;
await sql`alter table workflow_events add column if not exists from_node text`;
await sql`alter table workflow_events add column if not exists to_node text`;
await eventBus.connect();
await loadWorkstreams();
await eventBus.consumer(subjects.events, async (message) => { await handleWorkerResult(eventBus.decode(message)); return "ack"; });
setInterval(() => { void sql`update runtime_workers set status='offline', updated_at=now() where status='online' and last_heartbeat_at < now() - interval '45 seconds'`; }, 15_000);

async function startOrchestration(workstream: Workstream): Promise<void> {
  const orchestrator = new WorkstreamOrchestrator(workstream.id, workstream.goal); orchestrators.set(workstream.id, orchestrator);
  workstream.status = "active"; emit(workstream, "workstream.active", "Workflow started");
  const action = orchestrator.start(); const pm = workstream.agents.find((candidate) => candidate.role === "pm")!;
  await createMessage(workstream, "human", [pm.id], action.content, action.messageType, workstream.tasks[0] ? { taskId: workstream.tasks[0].id } : {});
}

async function handleWorkerResult(envelope: { type: string; workstreamId: string; payload: unknown; correlationId?: string }): Promise<void> {
  if (["turn.started", "turn.delta", "tool.started", "tool.completed", "turn.cancelled", "turn.failed"].includes(envelope.type)) {
    const workstream = workstreams.get(envelope.workstreamId); if (!workstream) return;
    const payload = envelope.payload as { agentId?: string; turnId?: string; text?: string; toolName?: string; output?: string; error?: { message?: string } };
    const agent = payload.agentId ? workstream.agents.find((candidate) => candidate.id === payload.agentId) : undefined;
    const message = envelope.type === "turn.delta" ? payload.text ?? "" : envelope.type === "tool.started" ? `${payload.toolName ?? "tool"} started` : envelope.type === "tool.completed" ? `${payload.toolName ?? "tool"} completed` : envelope.type === "turn.failed" ? payload.error?.message ?? "Provider turn failed" : envelope.type.replaceAll(".", " ");
    if (!message) return;
    recordWorkflowEvent(workstream, { id: randomUUID(), type: envelope.type, message, occurredAt: new Date().toISOString(), ...(agent?.role ? { role: agent.role } : {}), ...(agent?.id ? { from: agent.id } : {}) });
    return;
  }
  if (envelope.type === "run.started" || envelope.type === "run.heartbeat") {
    const workstream = workstreams.get(envelope.workstreamId); if (!workstream) return;
    const payload = envelope.payload as { agentId?: string; taskId?: string; elapsedMs?: number };
    const role = payload.agentId ? workstream.agents.find((agent) => agent.id === payload.agentId)?.role : undefined;
    recordWorkflowEvent(workstream, { id: randomUUID(), type: envelope.type, message: `${role ?? payload.agentId ?? "agent"} ${envelope.type === "run.heartbeat" ? `running (${Math.round((payload.elapsedMs ?? 0) / 1000)}s)` : "started"}`, occurredAt: new Date().toISOString(), ...(role ? { role } : {}) });
    return;
  }
  if (envelope.type !== "agent.turn.completed" && envelope.type !== "task.completed" && envelope.type !== "task.failed") return;
  app.log.info({ event: "worker.result.received", type: envelope.type, workstreamId: envelope.workstreamId, correlationId: envelope.correlationId }, "worker result received");
  const workstream = workstreams.get(envelope.workstreamId); const orchestrator = orchestrators.get(envelope.workstreamId); if (!workstream || !orchestrator) return;
  const raw = envelope.payload as { agentId?: string; taskId?: string; text?: string; error?: string; evidenceIds?: string[]; result?: { agentId?: string; taskId?: string; text?: string; error?: string; evidenceIds?: string[] } };
  const payload = raw.result ?? raw;
  const sender = workstream.agents.find((candidate) => candidate.id === payload.agentId);
  if (!sender) { app.log.warn({ event: "worker.result.ignored", workstreamId: envelope.workstreamId, agentId: payload.agentId, taskId: payload.taskId, payloadKeys: Object.keys(raw) }, "worker result agent not found"); return; }
  if (envelope.type === "task.failed") {
    const task = payload.taskId ? workstream.tasks.find((candidate) => candidate.id === payload.taskId) : undefined;
    if (task) { task.status = "failed"; task.updatedAt = new Date().toISOString(); await persistTask(task); }
    const reason = payload.error?.trim() || "provider execution failed";
    workstream.status = "waiting_for_human";
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.failed", message: `${task?.title ?? sender.role} → ${reason}`, occurredAt: new Date().toISOString(), role: sender.role });
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "workstream.waiting_for_human", message: "Provider execution failed; Human decision required", occurredAt: new Date().toISOString() });
    await persistWorkstreamStatus(workstream);
    return;
  }
  const resultText = payload.text?.trim() ?? "";
  if (sender.role === "pm" && resultText.startsWith("[CLARIFICATION_REQUEST]")) {
    const clarification = resultText.replace(/^\[CLARIFICATION_REQUEST\]\s*/i, "").trim();
    await createMessage(workstream, sender.id, ["human"], clarification, "clarification", { ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}) });
    workstream.status = "waiting_for_human";
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "workstream.clarification_requested", message: clarification, occurredAt: new Date().toISOString(), role: sender.role });
    await persistWorkstreamStatus(workstream);
    return;
  }
  if (!resultText) {
    const task = payload.taskId ? workstream.tasks.find((candidate) => candidate.id === payload.taskId) : undefined;
    if (task) { task.status = "failed"; task.updatedAt = new Date().toISOString(); await persistTask(task); }
    recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.failed", message: `${task?.title ?? sender.role} → provider returned no text summary`, occurredAt: new Date().toISOString(), role: sender.role });
    app.log.warn({ workstreamId: envelope.workstreamId, agentId: sender.id, taskId: payload.taskId }, "provider returned empty result");
    return;
  }
  const task = payload.taskId ? workstream.tasks.find((candidate) => candidate.id === payload.taskId) : undefined;
  if (task) {
    const evidenceIds = [...new Set(payload.evidenceIds ?? [])];
    const evidenceRows = evidenceIds.length ? await sql`select id from workspace_evidence where task_id = ${task.id} and id = any(${evidenceIds}::bigint[])` : [];
    if (workstream.workspaceRoot && (!evidenceIds.length || evidenceRows.length !== evidenceIds.length)) {
      task.status = "failed"; task.updatedAt = new Date().toISOString(); await persistTask(task);
      recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.failed", message: `${task.title} → evidence persistence incomplete`, occurredAt: new Date().toISOString(), role: sender.role });
      return;
    }
    task.status = "done"; task.evidence = [...new Set([...task.evidence, ...evidenceIds])]; task.updatedAt = new Date().toISOString(); await persistTask(task); recordWorkflowEvent(workstream, { id: randomUUID(), type: "task.completed", message: `${task.title} → done`, occurredAt: new Date().toISOString(), role: sender.role });
  }
  const eventType = sender.role === "pm" ? "goal.received" : sender.role === "pe" ? "task.decomposed" : ["coder", "backend", "frontend"].includes(sender.role) ? "design.completed" : /fail|missing|error/i.test(resultText) ? "qa.failed" : "qa.passed";
  const action = orchestrator.apply({ type: eventType, content: resultText, ...(payload.evidenceIds ? { evidenceIds: payload.evidenceIds } : {}) });
  if (!action) { workstream.status = "completed"; recordWorkflowEvent(workstream, { id: randomUUID(), type: "workstream.completed", message: "Orchestrator completed the workflow", occurredAt: new Date().toISOString() }); await persistWorkstreamStatus(workstream); return; }
  const recipient = action.recipientRole === "human" ? "human" : workstream.agents.find((candidate) => candidate.role === action.recipientRole)?.id ?? (action.recipientRole === "coder" ? workstream.agents.find((candidate) => ["backend", "frontend"].includes(candidate.role))?.id : undefined); if (!recipient) return;
  await createMessage(workstream, sender.id, [recipient], action.content, action.messageType, { ...(workstream.tasks[0] ? { taskId: workstream.tasks[0].id } : {}), ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}), ...(payload.evidenceIds ? { evidenceIds: payload.evidenceIds } : {}) });
  if (action.recipientRole === "human") { workstream.status = "waiting_for_human"; recordWorkflowEvent(workstream, { id: randomUUID(), type: "workstream.waiting_for_human", message: "Human approval required before completion", occurredAt: new Date().toISOString() }); }
}

await app.listen({ host: "0.0.0.0", port: Number(process.env.CONTROL_API_PORT ?? 3000) });

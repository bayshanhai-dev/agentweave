import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

type Role = "pm" | "pe" | "coder" | "qa";
type WorkflowEvent = { id: string; type: string; message: string; role?: Role; from?: string; to?: string; occurredAt: string };
type Agent = { id: string; role: Role; authority: "lead" | "reviewer" | "executor"; status: "idle" | "running" | "done" };
type Task = { id: string; workstreamId: string; title: string; status: "ready" | "assigned" | "running" | "review" | "blocked" | "done" | "cancelled"; ownerAgentId?: string; acceptanceCriteria: string[]; dependencies: string[]; evidence: string[]; createdAt: string; updatedAt: string };
type Workstream = { id: string; goal: string; flavor: "software-development"; status: string; provider: { tool: string; model: string }; workspaceRoot: string; agents: Agent[]; tasks: Task[]; events: WorkflowEvent[] };

const app = Fastify({ logger: true });
await app.register(websocket);
const workstreams = new Map<string, Workstream>();
const sql = postgres(process.env.DATABASE_URL ?? "postgres://agentweave:agentweave@localhost:5432/agentweave", { max: 5, connect_timeout: 10 });
const sockets = new Set<{ send: (data: string) => void }>();
const metrics = { requests: 0, workstreamsCreated: 0, runsStarted: 0, eventsEmitted: 0, workflowFailures: 0 };

app.addHook("onRequest", async (request, reply) => {
  metrics.requests += 1;
  reply.header("access-control-allow-origin", "*");
  reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
  reply.header("access-control-allow-headers", "content-type");
  if (request.method === "OPTIONS") return reply.code(204).send();
});
app.get("/health", async () => ({ status: "ok", service: "control-api" }));
app.get("/metrics", async (_request, reply) => {
  reply.type("text/plain; version=0.0.4");
  return Object.entries(metrics).map(([name, value]) => `agentweave_${name} ${value}`).join("\n") + "\n";
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
  const body = request.body as { from?: string; to?: string; content?: string; intent?: string } | undefined;
  if (!workstream) return reply.code(404).send({ error: "workstream_not_found" });
  if (!body?.content?.trim() || !body.to?.trim()) return reply.code(400).send({ error: "recipient_and_content_required" });
  const event = await createMessageEvent(workstream, body.from?.trim() || "human", body.to.trim(), body.content.trim(), body.intent || "question");
  return reply.code(201).send(event);
});
app.post("/api/workstreams", async (request, reply) => {
  const body = request.body as { goal?: string; tool?: string; model?: string; workspaceRoot?: string } | undefined;
  if (!body?.goal?.trim()) return reply.code(400).send({ error: "goal_required" });
  const id = randomUUID();
  const workstream: Workstream = {
    id, goal: body.goal.trim(), flavor: "software-development", status: "starting",
    provider: { tool: body.tool ?? "mock", model: body.model ?? "deterministic" },
    workspaceRoot: body.workspaceRoot?.trim() || "/workspaces/agentweave", tasks: [], events: [],
    agents: [
      { id: `${id}:pm`, role: "pm", authority: "lead", status: "idle" },
      { id: `${id}:pe`, role: "pe", authority: "reviewer", status: "idle" },
      { id: `${id}:coder-1`, role: "coder", authority: "executor", status: "idle" },
      { id: `${id}:qa`, role: "qa", authority: "reviewer", status: "idle" },
    ],
  };
  const task: Task = { id: `${id}:task-1`, workstreamId: id, title: "Implement the highest-impact improvement", status: "ready", acceptanceCriteria: ["Implementation is scoped to the Workstream goal", "Relevant checks and tests pass", "Evidence is attached for review"], dependencies: [], evidence: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  workstream.tasks.push(task);
  workstreams.set(id, workstream);
  await persistWorkstream(workstream); await persistTask(task);
  metrics.workstreamsCreated += 1;
  app.log.info({ workstreamId: id, flavor: workstream.flavor, provider: workstream.provider, workspaceRoot: workstream.workspaceRoot }, "workstream.created");
  emit(workstream, "workstream.created", "Software development hive created");
  void runHappyPath(workstream);
  return reply.code(201).send(workstream);
});
app.get("/events", { websocket: true }, (socket) => {
  sockets.add(socket);
  socket.send(JSON.stringify({ type: "system.connected", occurredAt: new Date().toISOString() }));
  socket.on("close", () => sockets.delete(socket));
});

function emit(workstream: Workstream, type: string, message: string, role?: Role): void {
  const event: WorkflowEvent = { id: randomUUID(), type, message, occurredAt: new Date().toISOString(), ...(role ? { role } : {}) };
  workstream.events.push(event);
  void persistEvent(workstream.id, event);
  void persistWorkstreamStatus(workstream);
  metrics.eventsEmitted += 1;
  if (type === "run.started") metrics.runsStarted += 1;
  app.log.info({ workstreamId: workstream.id, eventId: event.id, eventType: type, role }, "workflow.event");
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
    const loadedTasks = tasks.map((task) => ({ id: String(task.id), workstreamId: String(task.workstream_id), title: String(task.title), status: String(task.status) as Task["status"], ...(task.owner_agent_id ? { ownerAgentId: String(task.owner_agent_id) } : {}), acceptanceCriteria: task.acceptance_criteria as string[], dependencies: task.dependencies as string[], evidence: task.evidence as string[], createdAt: new Date(String(task.created_at)).toISOString(), updatedAt: new Date(String(task.updated_at)).toISOString() }));
    if (!loadedTasks.length) {
      const task: Task = { id: `${row.id}:task-1`, workstreamId: String(row.id), title: "Review and continue the Workstream", status: "ready", acceptanceCriteria: ["Work remains scoped to the Workstream goal", "Relevant checks pass", "Evidence is attached before review"], dependencies: [], evidence: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      loadedTasks.push(task); await persistTask(task);
    }
    workstreams.set(String(row.id), {
      id: String(row.id), goal: String(row.goal), flavor: "software-development", status: String(row.status),
      provider: { tool: String(row.tool), model: String(row.model) }, workspaceRoot: String(row.workspace_root),
      tasks: loadedTasks,
      agents: agents.map((agent) => ({ id: String(agent.id), role: String(agent.role) as Role, authority: String(agent.authority) as Agent["authority"], status: String(agent.status) as Agent["status"] })),
      events: events.map((event) => ({ id: String(event.id), type: String(event.type), message: String(event.message), ...(event.role && ["pm", "pe", "coder", "qa"].includes(String(event.role)) ? { role: String(event.role) as Role } : {}), ...(event.from_node ? { from: String(event.from_node) } : {}), ...(event.to_node ? { to: String(event.to_node) } : {}), occurredAt: new Date(String(event.occurred_at)).toISOString() })),
    });
  }
  app.log.info({ workstreamCount: workstreams.size }, "workstreams.loaded");
}

await sql`create table if not exists workstreams (id text primary key, goal text not null, flavor text not null, status text not null, tool text not null, model text not null, workspace_root text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
await sql`create table if not exists tasks (id text primary key, workstream_id text not null references workstreams(id) on delete cascade, title text not null, status text not null, owner_agent_id text, acceptance_criteria jsonb not null default '[]', dependencies jsonb not null default '[]', evidence jsonb not null default '[]', created_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
await sql`create table if not exists agents (id text primary key, workstream_id text not null references workstreams(id) on delete cascade, role text not null, authority text not null, status text not null)`;
await sql`create table if not exists workflow_events (id text primary key, workstream_id text not null references workstreams(id) on delete cascade, type text not null, message text not null, role text, from_node text, to_node text, occurred_at timestamptz not null)`;
await sql`alter table workflow_events add column if not exists from_node text`;
await sql`alter table workflow_events add column if not exists to_node text`;
await loadWorkstreams();

async function runHappyPath(workstream: Workstream): Promise<void> {
  const stages: Array<[Role, string, number]> = [
    ["pm", "PM decomposed the goal into an implementation task", 300],
    ["pe", "PE produced an implementation design", 500],
    ["coder", "Coder completed the implementation and attached evidence", 700],
    ["qa", "QA passed the implementation and attached review evidence", 500],
  ];
  try {
    workstream.status = "active";
    emit(workstream, "workstream.active", "Workflow started");
    for (const [role, message, delay] of stages) {
      const agent = workstream.agents.find((candidate) => candidate.role === role);
      if (agent) agent.status = "running";
      emit(workstream, "run.started", `${role.toUpperCase()} run started`, role);
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (agent) agent.status = "done";
      emit(workstream, `${role}.completed`, message, role);
    }
    workstream.status = "completed";
    emit(workstream, "workstream.completed", "Happy path completed");
  } catch (error) {
    metrics.workflowFailures += 1;
    workstream.status = "failed";
    app.log.error({ err: error, workstreamId: workstream.id }, "workflow.failed");
    emit(workstream, "workstream.failed", "Workflow failed");
  }
}

await app.listen({ host: "0.0.0.0", port: Number(process.env.CONTROL_API_PORT ?? 3000) });

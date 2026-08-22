import { connect, StringCodec } from "nats";
import { createProviderFromEnv, PostgresAgentSessionRepository } from "./providers/index.js";
import { AgentTaskExecutor, type AgentTask } from "./execution.js";

const workerId = process.env.WORKER_ID ?? "worker-local-1";
const roles = (process.env.WORKER_ROLES ?? "pm,pe,coder,qa").split(",");

console.log(JSON.stringify({
  event: "worker.started",
  workerId,
  roles,
  occurredAt: new Date().toISOString(),
}));

const provider = createProviderFromEnv();
const repository = new PostgresAgentSessionRepository();
const nc = await connect({ servers: process.env.NATS_URL ?? "nats://localhost:4222", name: workerId });
const codec = StringCodec();
const executor = new AgentTaskExecutor(provider, repository, workerId, async (event) => {
  nc.publish("agentweave.runs", codec.encode(JSON.stringify({ workerId, occurredAt: new Date().toISOString(), ...event })));
});
const subscription = nc.subscribe(process.env.WORKER_TASK_SUBJECT ?? "agentweave.tasks", { queue: process.env.WORKER_QUEUE ?? "agentweave-workers" });
void (async () => { for await (const message of subscription) { try { await executor.execute(JSON.parse(codec.decode(message.data)) as AgentTask); } catch (error) { console.error(JSON.stringify({ event: "worker.task_failed", workerId, error: error instanceof Error ? error.message : String(error) })); } } })();

setInterval(() => {
  console.log(JSON.stringify({ event: "worker.heartbeat", workerId, occurredAt: new Date().toISOString() }));
}, 15_000);

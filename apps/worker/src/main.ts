import { JetStreamEventBus, subjects } from "@agentweave/protocol/jetstream";
import { createProviderFromEnv } from "./providers/registry.js";
import type { ProviderRunEvent } from "./providers/types.js";
import { AgentTaskExecutor } from "./execution.js";
import { PostgresAgentSessionRepository } from "./providers/postgres-session-repository.js";

const workerId = process.env.WORKER_ID ?? "worker-local-1";
const agentId = process.env.AGENT_ID;
const provider = createProviderFromEnv();
const sessions = new PostgresAgentSessionRepository();
const executor = new AgentTaskExecutor(provider, sessions, workerId, async (event) => {
  if (currentEnvelope) await bus.publish(subjects.events.replace("*", currentEnvelope.workstreamId), { id: `${currentEnvelope.id}:${event.type}:${Date.now()}`, type: event.type, workstreamId: currentEnvelope.workstreamId, occurredAt: new Date().toISOString(), ...(currentEnvelope.correlationId ? { correlationId: currentEnvelope.correlationId } : {}), causationId: currentEnvelope.id, payload: event });
});
let currentEnvelope: ReturnType<typeof bus.decode> | undefined;
const bus = new JetStreamEventBus({ url: process.env.NATS_URL ?? "nats://localhost:4222", durableName: `${workerId}-inbox` });

console.log(JSON.stringify({ event: "worker.started", workerId, agentId, provider: provider.name, occurredAt: new Date().toISOString() }));
await bus.connect();

if (agentId) {
  await bus.consumer(subjects.inbox.replace("*", agentId), async (message) => {
    try {
      const envelope = bus.decode(message);
      currentEnvelope = envelope;
      const payload = envelope.payload as { senderId?: string; content?: string; taskId?: string; sessionId?: string; model?: string; workspacePath?: string };
      if (!payload.content) return "ack";
      await executor.execute({ taskId: payload.taskId ?? envelope.id, agentId: agentId!, workstreamId: envelope.workstreamId, ...(payload.sessionId ? { sessionId: payload.sessionId } : {}), prompt: payload.content, ...(payload.model ? { model: payload.model } : {}), ...(payload.workspacePath ? { workspacePath: payload.workspacePath } : {}), ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}), idempotencyKey: envelope.id });
      return "ack";
    } catch (error) {
      console.error(JSON.stringify({ event: "worker.message.failed", workerId, agentId, error: String(error), occurredAt: new Date().toISOString() }));
      return "retry";
    } finally { currentEnvelope = undefined; }
  });
}
setInterval(() => console.log(JSON.stringify({ event: "worker.heartbeat", workerId, agentId, occurredAt: new Date().toISOString() })), 15_000);

async function collectRun<T>(stream: AsyncGenerator<ProviderRunEvent, T>): Promise<{ events: ProviderRunEvent[]; result: T }> {
  const events: ProviderRunEvent[] = [];
  let step = await stream.next();
  while (!step.done) { events.push(step.value); step = await stream.next(); }
  return { events, result: step.value };
}

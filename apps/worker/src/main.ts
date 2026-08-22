import { JetStreamEventBus, subjects } from "@agentweave/protocol/jetstream";
import { createProviderFromEnv } from "./providers/registry.js";
import type { ProviderRunEvent } from "./providers/types.js";

const workerId = process.env.WORKER_ID ?? "worker-local-1";
const agentId = process.env.AGENT_ID;
const provider = createProviderFromEnv();
const bus = new JetStreamEventBus({ url: process.env.NATS_URL ?? "nats://localhost:4222", durableName: `${workerId}-inbox` });

console.log(JSON.stringify({ event: "worker.started", workerId, agentId, provider: provider.name, occurredAt: new Date().toISOString() }));
await bus.connect();

if (agentId) {
  await bus.consumer(subjects.inbox.replace("*", agentId), async (message) => {
    try {
      const envelope = bus.decode(message);
      const payload = envelope.payload as { senderId?: string; content?: string };
      if (!payload.content) return "ack";
      const session = await provider.createSession();
      const result = await collectRun(provider.run({ session, input: payload.content, correlationId: envelope.correlationId, idempotencyKey: envelope.id }));
      await bus.publish(subjects.events.replace("*", envelope.workstreamId), { id: `${envelope.id}:result`, type: "agent.turn.completed", workstreamId: envelope.workstreamId, occurredAt: new Date().toISOString(), ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}), causationId: envelope.id, payload: { agentId, senderId: payload.senderId, turnId: result.result.turnId, text: result.result.text, events: result.events } });
      return "ack";
    } catch (error) {
      console.error(JSON.stringify({ event: "worker.message.failed", workerId, agentId, error: String(error), occurredAt: new Date().toISOString() }));
      return "retry";
    }
  });
}
setInterval(() => console.log(JSON.stringify({ event: "worker.heartbeat", workerId, agentId, occurredAt: new Date().toISOString() })), 15_000);

async function collectRun<T>(stream: AsyncGenerator<ProviderRunEvent, T>): Promise<{ events: ProviderRunEvent[]; result: T }> {
  const events: ProviderRunEvent[] = [];
  let step = await stream.next();
  while (!step.done) { events.push(step.value); step = await stream.next(); }
  return { events, result: step.value };
}

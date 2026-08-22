import { JetStreamEventBus, subjects } from "@agentweave/protocol/jetstream";
import { createProviderFromEnv } from "./providers/registry.js";
import type { ProviderRunEvent } from "./providers/types.js";
import { AgentTaskExecutor } from "./runtime/execution.js";
import { AgentRuntime } from "./runtime/agent-runtime.js";
import { PostgresAgentSessionRepository } from "./providers/postgres-session-repository.js";

const workerId = process.env.WORKER_ID ?? "worker-local-1";
const provider = createProviderFromEnv();
const sessions = new PostgresAgentSessionRepository();
const executor = new AgentTaskExecutor(provider, sessions, workerId, async (event) => {
  if (currentEnvelope) await bus.publish(subjects.events.replace("*", currentEnvelope.workstreamId), { id: `${currentEnvelope.id}:${event.type}:${Date.now()}`, type: event.type, workstreamId: currentEnvelope.workstreamId, occurredAt: new Date().toISOString(), ...(currentEnvelope.correlationId ? { correlationId: currentEnvelope.correlationId } : {}), causationId: currentEnvelope.id, payload: event });
});
const runtimes = new Map<string, AgentRuntime>();
let currentEnvelope: ReturnType<typeof bus.decode> | undefined;
const bus = new JetStreamEventBus({ url: process.env.NATS_URL ?? "nats://localhost:4222", durableName: `${workerId}-inbox` });

const controlApiUrl = process.env.CONTROL_API_URL ?? "http://control-api:3000";
async function registerWorker(): Promise<void> { const payload = JSON.stringify({ workerId, provider: provider.name, roles: (process.env.WORKER_ROLES ?? "pm,pe,coder,qa").split(","), capabilities: ["streaming", "checkpoint", "resume", "cancellation"] }); for (;;) { try { const response = await fetch(`${controlApiUrl}/api/runtime/workers/register`, { method: "POST", headers: { "content-type": "application/json" }, body: payload }); if (response.ok) return; } catch { /* Control Plane may still be starting. */ } await new Promise((resolve) => setTimeout(resolve, 1000)); } }
async function heartbeat(): Promise<void> { try { await fetch(`${controlApiUrl}/api/runtime/workers/${encodeURIComponent(workerId)}/heartbeat`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } catch { /* Control Plane may restart; the next heartbeat retries. */ } }

console.log(JSON.stringify({ event: "worker.started", workerId, subscription: subjects.inbox, provider: provider.name, occurredAt: new Date().toISOString() }));
await bus.connect();
await registerWorker();

await bus.consumer(subjects.inbox, async (message) => {
    try {
      const envelope = bus.decode(message);
      currentEnvelope = envelope;
      const targetFromSubject = message.subject.split(".")[2];
      const payload = envelope.payload as { senderId?: string; recipientId?: string; agentInstanceId?: string; content?: string; taskId?: string; sessionId?: string; model?: string; workspacePath?: string };
      const targetAgentId = payload.agentInstanceId ?? payload.recipientId ?? targetFromSubject;
      if (!targetAgentId) return "dead-letter";
      if (!payload.content) return "ack";
      let runtime = runtimes.get(targetAgentId);
      if (!runtime) { runtime = new AgentRuntime(targetAgentId, executor); runtimes.set(targetAgentId, runtime); }
      await runtime.dispatch({ taskId: payload.taskId ?? envelope.id, agentId: targetAgentId, workstreamId: envelope.workstreamId, ...(payload.sessionId ? { sessionId: payload.sessionId } : {}), prompt: payload.content, ...(payload.model ? { model: payload.model } : {}), ...(payload.workspacePath ? { workspacePath: payload.workspacePath } : {}), ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}), idempotencyKey: envelope.id });
      return "ack";
    } catch (error) {
      console.error(JSON.stringify({ event: "worker.message.failed", workerId, subject: message.subject, error: String(error), occurredAt: new Date().toISOString() }));
      return "retry";
    } finally { currentEnvelope = undefined; }
  });
setInterval(() => { void heartbeat(); console.log(JSON.stringify({ event: "worker.heartbeat", workerId, subscription: subjects.inbox, provider: provider.name, occurredAt: new Date().toISOString() })); }, 15_000);

async function collectRun<T>(stream: AsyncGenerator<ProviderRunEvent, T>): Promise<{ events: ProviderRunEvent[]; result: T }> {
  const events: ProviderRunEvent[] = [];
  let step = await stream.next();
  while (!step.done) { events.push(step.value); step = await stream.next(); }
  return { events, result: step.value };
}

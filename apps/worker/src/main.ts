import { JetStreamEventBus, subjects } from "@agentweave/protocol/jetstream";
import { createProviderFromEnv } from "./providers/registry.js";
import type { ProviderRunEvent } from "./providers/types.js";
import { AgentTaskExecutor } from "./runtime/execution.js";
import { AgentRuntime } from "./runtime/agent-runtime.js";
import { PostgresAgentSessionRepository } from "./providers/postgres-session-repository.js";
import { createHash } from "node:crypto";
import { executionKeyForDelivery } from "./runtime/execution-key.js";

const workerId = process.env.WORKER_ID ?? "worker-local-1";
const provider = createProviderFromEnv();
const sessions = new PostgresAgentSessionRepository();
const executor = new AgentTaskExecutor(provider, sessions, workerId, async (event) => {
  if (currentEnvelope) await bus.publish(subjects.events.replace("*", currentEnvelope.workstreamId), { id: `${currentEnvelope.id}:${event.type}:${Date.now()}`, type: event.type, workstreamId: currentEnvelope.workstreamId, occurredAt: new Date().toISOString(), ...(currentEnvelope.correlationId ? { correlationId: currentEnvelope.correlationId } : {}), causationId: currentEnvelope.id, payload: event });
});
const runtimes = new Map<string, AgentRuntime>();
const activeWorkstreams = new Set<string>();
// JetStream redelivers a message when the provider turn outlives ack_wait.
// Keep a process-local execution gate so a redelivery cannot start a second
// provider turn for the same durable task while the first one is still live.
const inFlightTasks = new Set<string>();
let currentEnvelope: ReturnType<typeof bus.decode> | undefined;
const bus = new JetStreamEventBus({ url: process.env.NATS_URL ?? "nats://localhost:4222", durableName: `${workerId}-inbox-v2` });

const controlApiUrl = process.env.CONTROL_API_URL ?? "http://control-api:3000";
async function registerWorker(): Promise<void> { const payload = JSON.stringify({ workerId, provider: provider.name, roles: (process.env.WORKER_ROLES ?? "pm,pe,coder,qa").split(","), capabilities: ["streaming", "checkpoint", "resume", "cancellation"] }); for (;;) { try { const response = await fetch(`${controlApiUrl}/api/runtime/workers/register`, { method: "POST", headers: { "content-type": "application/json" }, body: payload }); if (response.ok) return; } catch { /* Control Plane may still be starting. */ } await new Promise((resolve) => setTimeout(resolve, 1000)); } }
async function heartbeat(): Promise<void> { try { await fetch(`${controlApiUrl}/api/runtime/workers/${encodeURIComponent(workerId)}/heartbeat`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } catch { /* Control Plane may restart; the next heartbeat retries. */ } }

console.log(JSON.stringify({ event: "worker.started", workerId, subscription: subjects.inbox, provider: provider.name, occurredAt: new Date().toISOString() }));
await bus.connect();
await registerWorker();

await bus.consumer(subjects.inbox, async (message) => {
    let executionKeyForCleanup: string | undefined;
    try {
      const envelope = bus.decode(message);
      console.log(JSON.stringify({ event: "worker.message.received", workerId, subject: message.subject, streamSequence: message.info.streamSequence, occurredAt: new Date().toISOString() }));
      currentEnvelope = envelope;
      activeWorkstreams.add(envelope.workstreamId);
      const statusResponse = await fetch(`${controlApiUrl}/api/workstreams/${encodeURIComponent(envelope.workstreamId)}`).catch(() => undefined);
      if (!statusResponse?.ok) return "retry";
      const workstream = await statusResponse.json() as { status?: string; workspaceRoot?: string; provider?: { model?: string } };
      const status = workstream.status;
      if (["paused", "waiting_for_human", "completed", "completing", "emergency_stopped", "archived"].includes(status ?? "")) return "ack";
      const targetFromSubject = message.subject.split(".")[2];
      const payload = envelope.payload as { senderId?: string; recipientId?: string; agentInstanceId?: string; content?: string; messageType?: string; taskId?: string; sessionId?: string; model?: string; workspacePath?: string };
      const targetAgentId = payload.agentInstanceId ?? payload.recipientId ?? targetFromSubject;
      if (!targetAgentId) return "dead-letter";
      if (!payload.content) return "ack";
      // A missing taskId must not turn every duplicate message into a new run.
      // Correlation is the stable identity for a handoff; envelope.id is only the
      // delivery identity and therefore cannot be used as the execution key.
      const handoffKey = envelope.correlationId ?? createHash("sha256").update(`${targetAgentId}|${payload.messageType ?? ""}|${payload.content}`).digest("hex").slice(0, 24);
      // A business task can legitimately visit several agents. Claims must be
      // unique per handoff/agent, while taskId remains stable for task status
      // and evidence association in the Control Plane.
      const executionKey = executionKeyForDelivery(payload.taskId, targetAgentId, handoffKey);
      executionKeyForCleanup = executionKey;
      if (inFlightTasks.has(executionKey)) {
        console.warn(JSON.stringify({ event: "worker.task.duplicate_suppressed", workerId, taskId: executionKey, messageId: envelope.id, occurredAt: new Date().toISOString() }));
        return "ack";
      }
      if (!(await executor.claimTask(executionKey, envelope.workstreamId, envelope.id))) {
        console.warn(JSON.stringify({ event: "worker.task.persistent_duplicate_suppressed", workerId, taskId: executionKey, messageId: envelope.id, occurredAt: new Date().toISOString() }));
        return "ack";
      }
      inFlightTasks.add(executionKey);
      let runtime = runtimes.get(targetAgentId);
      if (!runtime) { runtime = new AgentRuntime(targetAgentId, executor); runtimes.set(targetAgentId, runtime); }
      console.log(JSON.stringify({ event: "worker.task.dispatched", workerId, agentId: targetAgentId, taskId: payload.taskId ?? envelope.id, messageType: payload.messageType, occurredAt: new Date().toISOString() }));
      try {
        await runtime.dispatch({ taskId: payload.taskId ?? executionKey, executionKey, agentId: targetAgentId, workstreamId: envelope.workstreamId, ...(payload.sessionId ? { sessionId: payload.sessionId } : {}), prompt: payload.content, ...(payload.model || workstream.provider?.model ? { model: payload.model ?? workstream.provider?.model } : {}), ...(payload.workspacePath || workstream.workspaceRoot ? { workspacePath: payload.workspacePath ?? workstream.workspaceRoot } : {}), ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}), idempotencyKey: envelope.id, collectEvidence: Boolean(payload.taskId) });
        await executor.finishTask(executionKey, "completed");
      } catch (error) {
        await executor.finishTask(executionKey, "failed");
        throw error;
      }
      return "ack";
    } catch (error) {
      // Execution failures are already durable (AgentTaskExecutor emits task.failed).
      // Re-queueing the same inbox message would start the same provider turn again
      // and create an unbounded run/heartbeat loop. Only pre-dispatch infrastructure
      // failures should be retried; this handler has already passed the status check
      // and attempted the task, so terminate this delivery.
      console.error(JSON.stringify({ event: "worker.message.failed_terminal", workerId, subject: message.subject, error: String(error), occurredAt: new Date().toISOString() }));
      return "ack";
      } finally { if (executionKeyForCleanup) inFlightTasks.delete(executionKeyForCleanup); currentEnvelope = undefined; }
  });
console.log(JSON.stringify({ event: "worker.inbox.ready", workerId, subject: subjects.inbox, durable: `${workerId}-inbox-v2`, occurredAt: new Date().toISOString() }));
setInterval(() => { void heartbeat(); console.log(JSON.stringify({ event: "worker.heartbeat", workerId, subscription: subjects.inbox, provider: provider.name, occurredAt: new Date().toISOString() })); }, 15_000);
setInterval(() => { for (const workstreamId of activeWorkstreams) void fetch(`${controlApiUrl}/api/workstreams/${encodeURIComponent(workstreamId)}`).then(async (response) => { if (response.ok) await executor.updateWorkstreamControl(workstreamId, (await response.json() as { status?: "active" | "waiting_for_human" | "paused" | "emergency_stopped" | "completed" }).status ?? "active"); }).catch(() => undefined); }, 1000);

async function collectRun<T>(stream: AsyncGenerator<ProviderRunEvent, T>): Promise<{ events: ProviderRunEvent[]; result: T }> {
  const events: ProviderRunEvent[] = [];
  let step = await stream.next();
  while (!step.done) { events.push(step.value); step = await stream.next(); }
  return { events, result: step.value };
}

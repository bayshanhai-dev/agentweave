import { randomUUID } from "node:crypto";
import type { ProviderAdapter, ProviderRunEvent, ProviderSession, ProviderUsage } from "../providers/index.js";
import type { AgentSessionRecord, AgentSessionRepository } from "../providers/session-repository.js";
import { ExecutionControl } from "./execution-control.js";
import { assertWorkspace, collectWorkspaceEvidence, persistWorkspaceEvidence, validateWorkspacePath } from "../workspace/index.js";
import { EvidenceCollectorRegistry } from "../workspace/evidence.js";

export type AgentTask = { taskId: string; executionKey?: string; agentId: string; workstreamId?: string; sessionId?: string; role?: string; prompt: string; workspacePath?: string; model?: string; correlationId?: string; idempotencyKey?: string; collectEvidence?: boolean };
type ExecutionContext = { taskId: string; agentId?: string; workstreamId?: string; provider?: string; model?: string; usage?: ProviderUsage };
export type ExecutionSink = (event: (ProviderRunEvent & ExecutionContext) | ({ type: "run.started" | "run.heartbeat" | "task.completed" | "task.failed"; text?: string; error?: string; evidenceIds?: string[]; elapsedMs?: number } & ExecutionContext)) => Promise<void>;

export class AgentTaskExecutor {
  private readonly controls = new Map<string, ExecutionControl>();
  constructor(private readonly provider: ProviderAdapter, private readonly sessions: AgentSessionRepository, private readonly workerId: string, private readonly sink: ExecutionSink, private readonly evidence = new EvidenceCollectorRegistry()) {}
  async updateWorkstreamControl(workstreamId: string, state: import("./execution-control.js").ExecutionControlState): Promise<void> { await this.controls.get(workstreamId)?.update(state); }
  async claimTask(taskId: string, workstreamId: string | undefined, messageId: string): Promise<boolean> { return this.sessions.claimTask(taskId, workstreamId, this.workerId, messageId, new Date(Date.now() + Number(process.env.TASK_EXECUTION_LEASE_MS ?? 900_000)).toISOString()); }
  async finishTask(taskId: string, status: "completed" | "failed"): Promise<void> { await this.sessions.finishTask(taskId, status); }
  async execute(task: AgentTask, control = new ExecutionControl()): Promise<void> {
    if (task.workstreamId) { this.controls.set(task.workstreamId, control); }
    const runStartedAt = Date.now();
    await this.sink({ type: "run.started", taskId: task.taskId, agentId: task.agentId, ...(task.workstreamId ? { workstreamId: task.workstreamId } : {}), provider: this.provider.name, ...(task.model ? { model: task.model } : {}) });
    let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => { void this.sink({ type: "run.heartbeat", taskId: task.taskId, agentId: task.agentId, ...(task.workstreamId ? { workstreamId: task.workstreamId } : {}), provider: this.provider.name, ...(task.model ? { model: task.model } : {}), elapsedMs: Date.now() - runStartedAt }); }, Number(process.env.PROVIDER_HEARTBEAT_INTERVAL_MS ?? 3_000));
    let workspacePath: string | undefined;
    let id = task.sessionId ?? `${task.agentId}:${task.role ?? "agent"}`;
    let session!: ProviderSession;
    let record!: AgentSessionRecord;
    try {
      workspacePath = task.workspacePath ? validateWorkspacePath(task.workspacePath) : undefined;
      if (workspacePath) await assertWorkspace(workspacePath);
      const existing = (await this.sessions.listUnfinished(this.workerId)).find((candidate) => candidate.id === id || candidate.providerSessionId === id);
      const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
      const acquired = await this.sessions.acquireLease(existing?.id ?? id, this.workerId, leaseExpiresAt);
      if (existing && !acquired) throw new Error(`Session lease unavailable: ${id}`);
      session = existing ? await this.provider.resumeSession(this.toProviderSession(existing, workspacePath, task.model), task.correlationId) : await this.provider.createSession({ ...(task.model ? { model: task.model } : {}), ...(workspacePath ? { workspacePath } : {}), ...(task.correlationId ? { correlationId: task.correlationId } : {}) });
      record = { id, agentId: task.agentId, provider: session.provider, providerSessionId: session.providerSessionId, status: "active", lastEventSequence: existing?.lastEventSequence ?? 0, workerId: this.workerId, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: new Date().toISOString() };
      await this.sessions.save(record);
      if (!existing && !(await this.sessions.acquireLease(id, this.workerId, leaseExpiresAt))) throw new Error(`Session lease unavailable: ${id}`);
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      await this.sink({ type: "task.failed", taskId: task.taskId, agentId: task.agentId, ...(task.workstreamId ? { workstreamId: task.workstreamId } : {}), provider: this.provider.name, ...(task.model ? { model: task.model } : {}), error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    let activeTurnId: string | undefined;
    control.setHandlers({
      checkpoint: async () => { record.lastCheckpoint = await this.provider.checkpoint(session); record.updatedAt = new Date().toISOString(); await this.sessions.save(record); },
      cancel: async () => { if (activeTurnId) for await (const event of this.provider.cancel(session, activeTurnId, task.correlationId)) await this.emitProviderEvent(event, task, session); },
    });
    try {
      control.assertRunnable();
      const run = this.provider.run({ session, input: task.prompt, ...(task.model ? { model: task.model } : {}), ...(workspacePath ? { workspacePath } : {}), ...(task.correlationId ? { correlationId: task.correlationId } : {}), idempotencyKey: task.idempotencyKey ?? task.taskId });
      let result: { turnId: string; text: string; session: ProviderSession; usage?: ProviderUsage } | undefined;
      let usage: ProviderUsage | undefined;
      let step = await run.next();
      while (!step.done) { const event = step.value; if (event.type === "usage.updated") usage = event.usage; else if (event.type === "turn.completed" && event.usage) usage = event.usage; await this.emitProviderEvent(event, task, session); if (event.type === "turn.started") { activeTurnId = event.turnId; record.currentTurnId = event.turnId; } record.lastEventSequence += 1; record.updatedAt = new Date().toISOString(); await this.sessions.save(record); control.assertRunnable(); step = await run.next(); }
      result = step.value;
      if (result) { control.assertRunnable(); record.status = "completed"; record.currentTurnId = result.turnId; record.lastCheckpoint = await this.provider.checkpoint(result.session); await this.sessions.save(record); let evidenceIds: string[] = []; if (task.collectEvidence && workspacePath) { const collected = await this.evidence.collect({ taskId: task.taskId, workspacePath, ...(process.env.TEST_COMMAND ? { commands: [process.env.TEST_COMMAND] } : {}) }); for (const evidence of collected) evidenceIds.push(await persistWorkspaceEvidence(evidence)); } await this.sink({ type: "task.completed", taskId: task.taskId, agentId: task.agentId, ...(task.workstreamId ? { workstreamId: task.workstreamId } : {}), provider: result.session.provider, ...(result.session.model ? { model: result.session.model } : {}), ...(result.usage ?? usage ? { usage: result.usage ?? usage } : {}), text: result.text, ...(evidenceIds.length ? { evidenceIds } : {}) }); }
    } catch (error) { record.status = "failed"; record.updatedAt = new Date().toISOString(); await this.sessions.save(record); await this.sink({ type: "task.failed", taskId: task.taskId, agentId: task.agentId, ...(task.workstreamId ? { workstreamId: task.workstreamId } : {}), provider: session.provider, ...(session.model ? { model: session.model } : {}), error: error instanceof Error ? error.message : String(error) }); throw error; }
    finally { if (heartbeat) clearInterval(heartbeat); await this.sessions.releaseLease(id, this.workerId); if (task.workstreamId && this.controls.get(task.workstreamId) === control) this.controls.delete(task.workstreamId); }
  }
  private async emitProviderEvent(event: ProviderRunEvent, task: AgentTask, session: ProviderSession): Promise<void> {
    await this.sink({ ...event, taskId: task.taskId, agentId: task.agentId, ...(task.workstreamId ? { workstreamId: task.workstreamId } : {}), provider: session.provider, ...(session.model ? { model: session.model } : {}) });
  }
  private toProviderSession(record: AgentSessionRecord, workspacePath?: string, model?: string): ProviderSession { const now = record.updatedAt; return { provider: record.provider, providerSessionId: record.providerSessionId, ...(workspacePath ? { workspacePath } : {}), ...(model ? { model } : {}), ...(record.currentTurnId ? { providerTurnId: record.currentTurnId } : {}), status: record.status, createdAt: now, updatedAt: now }; }
}

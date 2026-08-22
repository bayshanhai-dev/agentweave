import { randomUUID } from "node:crypto";
import type { ProviderAdapter, ProviderRunEvent, ProviderSession } from "./providers/index.js";
import type { AgentSessionRecord, AgentSessionRepository } from "./providers/session-repository.js";

export type AgentTask = { taskId: string; agentId: string; sessionId?: string; role?: string; prompt: string; workspacePath?: string; model?: string; correlationId?: string; idempotencyKey?: string };
export type ExecutionSink = (event: ProviderRunEvent | { type: "task.completed" | "task.failed"; taskId: string; text?: string; error?: string }) => Promise<void>;

export class AgentTaskExecutor {
  constructor(private readonly provider: ProviderAdapter, private readonly sessions: AgentSessionRepository, private readonly workerId: string, private readonly sink: ExecutionSink) {}
  async execute(task: AgentTask): Promise<void> {
    const id = task.sessionId ?? `${task.agentId}:${task.role ?? "agent"}`;
    const existing = (await this.sessions.listUnfinished(this.workerId)).find((session) => session.id === id || session.providerSessionId === id);
    const acquired = await this.sessions.acquireLease(existing?.id ?? id, this.workerId, new Date(Date.now() + 60_000).toISOString());
    if (existing && !acquired) throw new Error(`Session lease unavailable: ${id}`);
    const session = existing ? await this.provider.resumeSession(this.toProviderSession(existing), task.correlationId) : await this.provider.createSession({ ...(task.model ? { model: task.model } : {}), ...(task.workspacePath ? { workspacePath: task.workspacePath } : {}), ...(task.correlationId ? { correlationId: task.correlationId } : {}) });
    const record: AgentSessionRecord = { id, agentId: task.agentId, provider: session.provider, providerSessionId: session.providerSessionId, status: "active", lastEventSequence: existing?.lastEventSequence ?? 0, workerId: this.workerId, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: new Date().toISOString() };
    await this.sessions.save(record);
    try {
      const run = this.provider.run({ session, input: task.prompt, ...(task.model ? { model: task.model } : {}), ...(task.workspacePath ? { workspacePath: task.workspacePath } : {}), correlationId: task.correlationId ?? randomUUID(), idempotencyKey: task.idempotencyKey ?? task.taskId });
      let result: { turnId: string; text: string; session: ProviderSession } | undefined;
      let step = await run.next();
      while (!step.done) { const event = step.value; await this.sink(event); if (event.type === "turn.started") record.currentTurnId = event.turnId; record.lastEventSequence += 1; record.updatedAt = new Date().toISOString(); await this.sessions.save(record); step = await run.next(); }
      result = step.value;
      if (result) { record.status = "completed"; record.currentTurnId = result.turnId; record.lastCheckpoint = await this.provider.checkpoint(result.session); await this.sessions.save(record); await this.sink({ type: "task.completed", taskId: task.taskId, text: result.text }); }
    } catch (error) { record.status = "failed"; record.updatedAt = new Date().toISOString(); await this.sessions.save(record); await this.sink({ type: "task.failed", taskId: task.taskId, error: error instanceof Error ? error.message : String(error) }); throw error; }
    finally { await this.sessions.releaseLease(id, this.workerId); }
  }
  private toProviderSession(record: AgentSessionRecord): ProviderSession { const now = record.updatedAt; return { provider: record.provider, providerSessionId: record.providerSessionId, ...(record.currentTurnId ? { providerTurnId: record.currentTurnId } : {}), status: record.status, createdAt: now, updatedAt: now, ...(record.lastCheckpoint ? {} : {}) }; }
}

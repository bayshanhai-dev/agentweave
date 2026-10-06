import { randomUUID } from "node:crypto";
import type { ProviderAdapter, ProviderRunEvent, ProviderSession, ProviderUsage } from "../providers/index.js";
import type { AgentSessionRecord, AgentSessionRepository } from "../providers/session-repository.js";
import { ExecutionControl } from "./execution-control.js";
import { assertWorkspace, collectWorkspaceEvidence, persistWorkspaceEvidence, validateWorkspacePath } from "../workspace/index.js";
import { EvidenceCollectorRegistry } from "../workspace/evidence.js";
import { agentTurnResultSchema, type AgentTurnResult } from "@agentweave/protocol";
import type { ProviderRunResult } from "../providers/types.js";
import { parseAgentTurnResult } from "../providers/agent-turn-result.js";

export type AgentTask = { taskId: string; executionKey?: string; agentId: string; workstreamId?: string; sessionId?: string; role?: string; prompt: string; workspacePath?: string; model?: string; correlationId?: string; idempotencyKey?: string; collectEvidence?: boolean };
type ExecutionContext = { taskId: string; agentId?: string; workstreamId?: string; provider?: string; model?: string; usage?: ProviderUsage };
export type ExecutionSink = (event: (ProviderRunEvent & ExecutionContext) | ({ type: "run.started" | "run.heartbeat" | "task.completed" | "task.failed"; turnId?: string; structuredResult?: AgentTurnResult; text?: string; error?: string; evidenceIds?: string[]; turnBudgetExhausted?: boolean; elapsedMs?: number } & ExecutionContext)) => Promise<void>;

const DEFAULT_MAX_TURNS = 5;
const MAX_OBSERVATION_CHARS = 4000;

/**
 * Max agent-owned turns per task execution. Conservative default; 1 restores
 * the legacy single-turn behavior.
 */
export function resolveMaxTurns(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.AGENT_MAX_TURNS ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_TURNS;
  return Math.floor(parsed);
}

/**
 * The worker-side loop continues only when a turn explicitly opts into another
 * turn. Completion markers (completionProposal / decision complete / human
 * block) and outbound handoffs (tasks / messages, owned by the control plane's
 * dispatch semantics) always end the loop. Anything else keeps the legacy
 * single-turn behavior, so existing journeys are unaffected.
 */
function wantsAnotherTurn(result: AgentTurnResult | undefined): boolean {
  if (!result) return false;
  if (result.completionProposal || result.humanBlock) return false;
  if (result.decision?.action !== "continue") return false;
  if (result.tasks.length > 0 || result.messages.length > 0) return false;
  return true;
}

/** Next turn input, built from the previous turn's observation. Sessions carry full history, so this stays lean. */
function continuationInput(task: AgentTask, turn: number, maxTurns: number, text: string, summary?: string): string {
  const observation = (summary || text || "").slice(0, MAX_OBSERVATION_CHARS);
  return [
    `[agentweave turn=${turn}/${maxTurns} task=${task.taskId}]`,
    "Continuing your own work on the goal. Observation from your previous turn:",
    observation,
    "",
    "If the work is complete, return a structured result with a completion proposal.",
    'Otherwise return decision {"action":"continue"} with a brief reason and keep working.',
  ].join("\n");
}

function mergeUsage(a: ProviderUsage | undefined, b: ProviderUsage | undefined): ProviderUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  return {
    source: b.source !== "unknown" ? b.source : a.source,
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
    costUsd: sum(a.costUsd, b.costUsd),
  };
}

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
    const maxTurns = resolveMaxTurns();
    const idempotencyBase = task.idempotencyKey ?? task.taskId;
    let activeTurnId: string | undefined;
    let currentSession = session;
    control.setHandlers({
      checkpoint: async () => { record.lastCheckpoint = await this.provider.checkpoint(currentSession); record.updatedAt = new Date().toISOString(); await this.sessions.save(record); },
      cancel: async () => { if (activeTurnId) for await (const event of this.provider.cancel(currentSession, activeTurnId, task.correlationId)) await this.emitProviderEvent(event, task, currentSession); },
    });
    try {
      let turn = 0;
      let input = task.prompt;
      let result: ProviderRunResult | undefined;
      let structuredResult: AgentTurnResult | undefined;
      let totalUsage: ProviderUsage | undefined;
      let turnBudgetExhausted = false;
      while (true) {
        turn += 1;
        control.assertRunnable();
        const run = this.provider.run({ session: currentSession, input, ...(task.model ? { model: task.model } : {}), ...(workspacePath ? { workspacePath } : {}), ...(task.correlationId ? { correlationId: task.correlationId } : {}), idempotencyKey: `${idempotencyBase}:turn:${turn}` });
        let turnUsage: ProviderUsage | undefined;
        let step = await run.next();
        while (!step.done) {
          const event = step.value;
          if (event.type === "usage.updated") turnUsage = event.usage;
          else if (event.type === "turn.completed" && event.usage) turnUsage = event.usage;
          await this.emitProviderEvent(event, task, currentSession);
          if (event.type === "turn.started") { activeTurnId = event.turnId; record.currentTurnId = event.turnId; }
          record.lastEventSequence += 1; record.updatedAt = new Date().toISOString(); await this.sessions.save(record);
          control.assertRunnable();
          step = await run.next();
        }
        const turnResult: ProviderRunResult | undefined = step.value;
        if (!turnResult) break;
        currentSession = turnResult.session;
        totalUsage = mergeUsage(totalUsage, turnResult.usage ?? turnUsage);
        result = turnResult;
        structuredResult = turnResult.structuredResult !== undefined
          ? agentTurnResultSchema.parse(turnResult.structuredResult)
          : /^\s*(?:\{|```json\b)/.test(turnResult.text) ? parseAgentTurnResult(turnResult.text) : undefined;
        record.currentTurnId = turnResult.turnId;
        record.lastCheckpoint = await this.provider.checkpoint(turnResult.session);
        record.updatedAt = new Date().toISOString();
        await this.sessions.save(record);
        if (!wantsAnotherTurn(structuredResult)) break;
        if (turn >= maxTurns) { turnBudgetExhausted = true; break; }
        input = continuationInput(task, turn + 1, maxTurns, turnResult.text, structuredResult?.summary);
      }
      if (result) {
        control.assertRunnable();
        record.status = "completed";
        record.updatedAt = new Date().toISOString();
        await this.sessions.save(record);
        const evidenceIds: string[] = [];
        if (task.collectEvidence && workspacePath) {
          const collected = await this.evidence.collect({ taskId: task.taskId, workspacePath, ...(process.env.TEST_COMMAND ? { commands: [process.env.TEST_COMMAND] } : {}) });
          for (const evidence of collected) evidenceIds.push(await persistWorkspaceEvidence(evidence));
        }
        await this.sink({ type: "task.completed", turnId: result.turnId, ...(structuredResult ? { structuredResult } : {}), taskId: task.taskId, agentId: task.agentId, ...(task.workstreamId ? { workstreamId: task.workstreamId } : {}), provider: result.session.provider, ...(result.session.model ? { model: result.session.model } : {}), ...(totalUsage ? { usage: totalUsage } : {}), text: result.text, ...(evidenceIds.length ? { evidenceIds } : {}), ...(turnBudgetExhausted ? { turnBudgetExhausted: true } : {}) });
      }
    } catch (error) { record.status = "failed"; record.updatedAt = new Date().toISOString(); await this.sessions.save(record); await this.sink({ type: "task.failed", taskId: task.taskId, agentId: task.agentId, ...(task.workstreamId ? { workstreamId: task.workstreamId } : {}), provider: session.provider, ...(session.model ? { model: session.model } : {}), error: error instanceof Error ? error.message : String(error) }); throw error; }
    finally { if (heartbeat) clearInterval(heartbeat); await this.sessions.releaseLease(id, this.workerId); if (task.workstreamId && this.controls.get(task.workstreamId) === control) this.controls.delete(task.workstreamId); }
  }
  private async emitProviderEvent(event: ProviderRunEvent, task: AgentTask, session: ProviderSession): Promise<void> {
    await this.sink({ ...event, taskId: task.taskId, agentId: task.agentId, ...(task.workstreamId ? { workstreamId: task.workstreamId } : {}), provider: session.provider, ...(session.model ? { model: session.model } : {}) });
  }
  private toProviderSession(record: AgentSessionRecord, workspacePath?: string, model?: string): ProviderSession { const now = record.updatedAt; return { provider: record.provider, providerSessionId: record.providerSessionId, ...(workspacePath ? { workspacePath } : {}), ...(model ? { model } : {}), ...(record.currentTurnId ? { providerTurnId: record.currentTurnId } : {}), status: record.status, createdAt: now, updatedAt: now }; }
}

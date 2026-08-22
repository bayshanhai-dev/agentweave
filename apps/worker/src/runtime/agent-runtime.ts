import { AgentTaskExecutor, type AgentTask } from "./execution.js";

export type AgentRuntimeStatus = "idle" | "running" | "failed" | "stopped";

/** Runtime actor for one dynamic Agent instance. It serializes that Agent's inbox. */
export class AgentRuntime {
  status: AgentRuntimeStatus = "idle";
  private tail: Promise<void> = Promise.resolve();
  constructor(readonly agentId: string, private readonly executor: AgentTaskExecutor) {}
  dispatch(task: AgentTask): Promise<void> {
    const run = this.tail.then(async () => { this.status = "running"; try { await this.executor.execute({ ...task, agentId: this.agentId }); this.status = "idle"; } catch (error) { this.status = "failed"; throw error; } });
    this.tail = run.catch(() => undefined);
    return run;
  }
  stop(): void { this.status = "stopped"; }
}

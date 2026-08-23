import { AgentTaskExecutor, type AgentTask } from "./execution.js";
import { ExecutionControl } from "./execution-control.js";

export type AgentRuntimeStatus = "idle" | "running" | "failed" | "stopped";

/** Runtime actor for one dynamic Agent instance. It serializes that Agent's inbox. */
export class AgentRuntime {
  status: AgentRuntimeStatus = "idle";
  private tail: Promise<void> = Promise.resolve();
  private activeControl?: ExecutionControl;
  private stopped = false;
  constructor(readonly agentId: string, private readonly executor: AgentTaskExecutor) {}
  dispatch(task: AgentTask): Promise<void> {
    const run = this.tail.then(async () => { if (this.stopped) throw new Error(`Agent runtime stopped: ${this.agentId}`); this.status = "running"; const control = new ExecutionControl(); this.activeControl = control; try { await this.executor.execute({ ...task, agentId: this.agentId }, control); this.status = "idle"; } catch (error) { this.status = "failed"; throw error; } finally { if (this.activeControl === control) this.activeControl = undefined; } });
    this.tail = run.catch(() => undefined);
    return run;
  }
  stop(): void { this.stopped = true; this.status = "stopped"; void this.activeControl?.update("emergency_stopped"); }
}

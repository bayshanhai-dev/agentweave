export type ExecutionControlState = "active" | "waiting_for_human" | "paused" | "emergency_stopped" | "completed";

export class ExecutionControl {
  private state: ExecutionControlState = "active";
  private checkpointHandler?: () => Promise<void>;
  private cancelHandler?: () => Promise<void>;
  setHandlers(handlers: { checkpoint: () => Promise<void>; cancel: () => Promise<void> }): void { this.checkpointHandler = handlers.checkpoint; this.cancelHandler = handlers.cancel; }
  async update(next: ExecutionControlState): Promise<void> { if (next === this.state) return; this.state = next; if (next === "paused" || next === "waiting_for_human") await this.checkpointHandler?.(); if (next === "paused" || next === "emergency_stopped") await this.cancelHandler?.(); }
  get current(): ExecutionControlState { return this.state; }
  assertRunnable(): void { if (this.state === "emergency_stopped") throw new Error("Execution stopped by operator"); if (this.state === "paused" || this.state === "waiting_for_human") throw new Error(`Execution is ${this.state}`); }
}

export class WorkstreamControlPoller {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly apiUrl: string, private readonly intervalMs = 1000) {}
  start(workstreamId: string, control: ExecutionControl): void { const poll = async () => { try { const response = await fetch(`${this.apiUrl}/api/workstreams/${workstreamId}`); if (response.ok) { const data = await response.json() as { status?: ExecutionControlState }; if (data.status) await control.update(data.status); } } catch { /* retry on next interval */ } }; void poll(); this.timer = setInterval(() => void poll(), this.intervalMs); }
  stop(): void { if (this.timer) clearInterval(this.timer); }
}

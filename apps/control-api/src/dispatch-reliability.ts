export const inboxPublishAttempts = 3;
export const inboxPublishBackoffsMs = [250, 1_000] as const;
export const implementationTriggerWatchdogMs = 180_000;

export function shouldArmTriggerWatchdog(
  content: string,
  recipientId: string,
  leadAgentId: string | undefined,
): boolean {
  return Boolean(
    leadAgentId &&
    recipientId === leadAgentId &&
    content.includes("[agentweave implementation-trigger]"),
  );
}

export function shouldArmDurableTaskWatchdog(taskId: string | undefined, content: string, recipientId: string): boolean {
  return Boolean(taskId && recipientId !== "human" && content.startsWith("[agentweave template="));
}

export function durableDispatchTimeoutDecision(
  taskStatus: string | undefined,
  isRedrive: boolean,
): "ignore" | "redrive" | "fail" {
  if (!taskStatus || ["done", "failed", "cancelled"].includes(taskStatus)) return "ignore";
  return isRedrive ? "fail" : "redrive";
}

export function armTriggerWatchdogForDispatch(
  watchdog: TriggerDispatchWatchdog,
  workstreamId: string,
  correlationId: string,
  content: string,
  recipientId: string,
  leadAgentId: string | undefined,
  onExpired: () => void | Promise<void>,
): boolean {
  if (!shouldArmTriggerWatchdog(content, recipientId, leadAgentId)) return false;
  watchdog.arm(workstreamId, correlationId, onExpired);
  return true;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export async function publishWithRetry(
  publish: () => Promise<void>,
  options: {
    attempts?: number;
    backoffsMs?: readonly number[];
    delay?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  const attempts = options.attempts ?? inboxPublishAttempts;
  const backoffsMs = options.backoffsMs ?? inboxPublishBackoffsMs;
  const delay = options.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await publish();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(backoffsMs[attempt - 1] ?? backoffsMs.at(-1) ?? 0);
    }
  }
  throw lastError;
}

export class TriggerDispatchWatchdog {
  private readonly timers = new Map<string, { correlationId: string; timer: TimerHandle }>();

  constructor(private readonly timeoutMs = implementationTriggerWatchdogMs) {}

  arm(workstreamId: string, correlationId: string, onExpired: () => void | Promise<void>): void {
    this.clear(workstreamId);
    const timer = setTimeout(() => {
      this.timers.delete(workstreamId);
      void onExpired();
    }, this.timeoutMs);
    timer.unref();
    this.timers.set(workstreamId, { correlationId, timer });
  }

  clear(workstreamId: string): boolean {
    const tracked = this.timers.get(workstreamId);
    if (!tracked) return false;
    clearTimeout(tracked.timer);
    this.timers.delete(workstreamId);
    return true;
  }

  clearForCorrelation(workstreamId: string, correlationId: string | undefined): boolean {
    const tracked = this.timers.get(workstreamId);
    if (!tracked || !correlationId || tracked.correlationId !== correlationId) return false;
    return this.clear(workstreamId);
  }
}

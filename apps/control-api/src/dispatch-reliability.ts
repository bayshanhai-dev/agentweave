export const inboxPublishAttempts = 3;
export const inboxPublishBackoffsMs = [250, 1_000] as const;
export const implementationTriggerWatchdogMs = 180_000;

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

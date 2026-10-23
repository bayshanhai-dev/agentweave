export const inboxPublishAttempts = 3;
export const inboxPublishBackoffsMs = [250, 1_000] as const;
export const implementationTriggerWatchdogMs = 180_000;
/**
 * A durable task handoff whose newest delivery is older than this is treated
 * as lost when the owning Agent is idle and no execution claim exists: the
 * watchdog cycle (180s) plus a full re-drive window passed without the task
 * ever starting. Reconciliation closes the stale delivery and re-dispatches.
 */
export const durableTaskDeliveryStaleMs = 360_000;

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

/**
 * A dispatch timeout must not be decided while the Workstream sits at a
 * Human gate: the handoff is legitimately held, not lost. The decision is
 * deferred until the Workstream is active again (activation reconciliation
 * and the re-armed watchdog take it from there).
 */
export function shouldDeferDispatchTimeout(
  workstreamStatus: string | undefined,
): boolean {
  return (
    workstreamStatus === "waiting_for_human" ||
    workstreamStatus === "paused" ||
    workstreamStatus === "completing" ||
    workstreamStatus === "emergency_stopped"
  );
}

export function durableDispatchTimeoutDecision(
  taskStatus: string | undefined,
  isRedrive: boolean,
): "ignore" | "redrive" | "fail" {
  if (!taskStatus || ["done", "failed", "cancelled"].includes(taskStatus)) return "ignore";
  return isRedrive ? "fail" : "redrive";
}

/**
 * Full timeout action for a durable task handoff. The bare decision above
 * only sees message bookkeeping; live runs showed two ways that misjudges:
 * a handoff queued behind the owner Agent's current execution is not lost
 * (it starts when the Agent frees up), and a handoff the worker already
 * claimed under an earlier correlation is executing even though the armed
 * timer tracks the re-drive's correlation. Both must defer — re-arm and
 * look again later — instead of re-driving (which piles up duplicate
 * handoffs) or failing a task that is mid-execution.
 */
export function durableDispatchTimeoutAction(input: {
  taskStatus: string | undefined;
  isRedrive: boolean;
  hasExecutionClaim: boolean;
  ownerBusy: boolean;
}): "ignore" | "defer" | "redrive" | "fail" {
  const decision = durableDispatchTimeoutDecision(input.taskStatus, input.isRedrive);
  if (decision === "ignore") return "ignore";
  if (input.hasExecutionClaim || input.ownerBusy) return "defer";
  return decision;
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

/**
 * One timer per (Workstream, correlation) dispatch. Keying by Workstream
 * alone let parallel handoffs armed in the same burst silently cancel each
 * other, leaving every task but the last without timeout protection.
 */
export class TriggerDispatchWatchdog {
  private readonly timers = new Map<string, { workstreamId: string; timer: TimerHandle }>();

  constructor(private readonly timeoutMs = implementationTriggerWatchdogMs) {}

  private key(workstreamId: string, correlationId: string): string {
    return `${workstreamId}:${correlationId}`;
  }

  arm(workstreamId: string, correlationId: string, onExpired: () => void | Promise<void>): void {
    const key = this.key(workstreamId, correlationId);
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void onExpired();
    }, this.timeoutMs);
    timer.unref();
    this.timers.set(key, { workstreamId, timer });
  }

  clear(workstreamId: string): boolean {
    let cleared = false;
    for (const [key, tracked] of this.timers) {
      if (tracked.workstreamId !== workstreamId) continue;
      clearTimeout(tracked.timer);
      this.timers.delete(key);
      cleared = true;
    }
    return cleared;
  }

  clearForCorrelation(workstreamId: string, correlationId: string | undefined): boolean {
    if (!correlationId) return false;
    const key = this.key(workstreamId, correlationId);
    const tracked = this.timers.get(key);
    if (!tracked) return false;
    clearTimeout(tracked.timer);
    this.timers.delete(key);
    return true;
  }
}

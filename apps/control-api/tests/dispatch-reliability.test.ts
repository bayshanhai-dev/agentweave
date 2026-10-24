import { describe, expect, it, vi } from "vitest";
import { armTriggerWatchdogForDispatch, durableDispatchTimeoutAction, durableDispatchTimeoutDecision, executionClaimCutoffForTask, implementationTriggerWatchdogMs, publishWithRetry, shouldArmDurableTaskWatchdog, shouldDeferDispatchTimeout, TriggerDispatchWatchdog } from "../src/dispatch-reliability.js";

describe("publishWithRetry", () => {
  it("retries a failed publish with the configured backoff", async () => {
    const publish = vi.fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockRejectedValueOnce(new Error("still unavailable"))
      .mockResolvedValue(undefined);
    const delay = vi.fn().mockResolvedValue(undefined);

    await publishWithRetry(publish, { backoffsMs: [250, 1_000], delay });

    expect(publish).toHaveBeenCalledTimes(3);
    expect(delay.mock.calls).toEqual([[250], [1_000]]);
  });

  it("throws the final error after three attempts", async () => {
    const failure = new Error("unavailable");
    const publish = vi.fn().mockRejectedValue(failure);

    await expect(publishWithRetry(publish, { backoffsMs: [0, 0], delay: async () => undefined })).rejects.toBe(failure);
    expect(publish).toHaveBeenCalledTimes(3);
  });
});

describe("TriggerDispatchWatchdog", () => {
  it("gives lead decomposition turns a 600-second no-result window", async () => {
    vi.useFakeTimers();
    try {
      const expired = vi.fn();
      const watchdog = new TriggerDispatchWatchdog();
      expect(implementationTriggerWatchdogMs).toBe(600_000);
      expect(armTriggerWatchdogForDispatch(
        watchdog,
        "workstream-1",
        "correlation-1",
        "[agentweave implementation-trigger] decompose",
        "lead-1",
        "lead-1",
        expired,
      )).toBe(true);

      await vi.advanceTimersByTimeAsync(599_999);
      expect(expired).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(expired).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms for a decomposition re-prompt dispatched to the lead", () => {
    const reprompt = "Reply with a task list.\n\n[agentweave implementation-trigger] Original trigger";
    const watchdog = new TriggerDispatchWatchdog();
    const arm = vi.spyOn(watchdog, "arm");

    expect(armTriggerWatchdogForDispatch(watchdog, "workstream-1", "correlation-1", reprompt, "lead-1", "lead-1", vi.fn())).toBe(true);
    expect(arm).toHaveBeenCalledOnce();
    watchdog.clear("workstream-1");

    expect(armTriggerWatchdogForDispatch(watchdog, "workstream-1", "correlation-2", reprompt, "worker-1", "lead-1", vi.fn())).toBe(false);
    expect(armTriggerWatchdogForDispatch(watchdog, "workstream-1", "correlation-3", "ordinary task", "lead-1", "lead-1", vi.fn())).toBe(false);
    expect(arm).toHaveBeenCalledOnce();
  });

  it("expires an armed trigger and can be cleared by correlation", async () => {
    vi.useFakeTimers();
    try {
      const expired = vi.fn();
      const watchdog = new TriggerDispatchWatchdog(180_000);
      watchdog.arm("workstream-1", "correlation-1", expired);
      expect(watchdog.clearForCorrelation("workstream-1", "different-correlation")).toBe(false);

      await vi.advanceTimersByTimeAsync(180_000);
      expect(expired).toHaveBeenCalledOnce();

      watchdog.arm("workstream-1", "correlation-2", expired);
      expect(watchdog.clearForCorrelation("workstream-1", "correlation-2")).toBe(true);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(expired).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps independent timers for parallel dispatches in one workstream", async () => {
    vi.useFakeTimers();
    try {
      const first = vi.fn();
      const second = vi.fn();
      const watchdog = new TriggerDispatchWatchdog(180_000);
      watchdog.arm("workstream-1", "correlation-1", first);
      watchdog.arm("workstream-1", "correlation-2", second);

      await vi.advanceTimersByTimeAsync(180_000);
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clearing one correlation leaves the workstream's other timers armed, and clear drops them all", async () => {
    vi.useFakeTimers();
    try {
      const first = vi.fn();
      const second = vi.fn();
      const other = vi.fn();
      const watchdog = new TriggerDispatchWatchdog(180_000);
      watchdog.arm("workstream-1", "correlation-1", first);
      watchdog.arm("workstream-1", "correlation-2", second);
      watchdog.arm("workstream-2", "correlation-1", other);

      expect(watchdog.clearForCorrelation("workstream-1", "correlation-1")).toBe(true);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
      expect(other).toHaveBeenCalledOnce();

      watchdog.arm("workstream-1", "correlation-3", first);
      watchdog.arm("workstream-1", "correlation-4", second);
      expect(watchdog.clear("workstream-1")).toBe(true);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("durable task dispatch recovery", () => {
  it("scopes execution claims to handoffs started after the latest task gate", () => {
    expect(executionClaimCutoffForTask([
      { type: "task.gated", taskId: "task-1", occurredAt: "2026-10-23T23:18:46.000Z" },
      { type: "task.gated", taskId: "task-2", occurredAt: "2026-10-23T23:19:00.000Z" },
      { type: "task.gated", taskId: "task-1", occurredAt: "2026-10-23T23:20:00.000Z" },
    ], "task-1")).toBe("2026-10-23T23:20:00.000Z");
    expect(executionClaimCutoffForTask([], "task-1")).toBeUndefined();
  });

  it("watches executable orchestration handoffs but not Human decisions", () => {
    const prompt = "[agentweave template=software-development phase=execution recipient=backend]";
    expect(shouldArmDurableTaskWatchdog("task-1", prompt, "backend-1")).toBe(true);
    expect(shouldArmDurableTaskWatchdog(undefined, prompt, "backend-1")).toBe(false);
    expect(shouldArmDurableTaskWatchdog("task-1", prompt, "human")).toBe(false);
    expect(shouldArmDurableTaskWatchdog("task-1", "ordinary message", "backend-1")).toBe(false);
  });

  it("re-drives once, then fails loudly instead of silently stalling", () => {
    expect(durableDispatchTimeoutDecision("running", false)).toBe("redrive");
    expect(durableDispatchTimeoutDecision("running", true)).toBe("fail");
    expect(durableDispatchTimeoutDecision("done", false)).toBe("ignore");
  });

  it("defers instead of re-driving when the handoff is queued behind a busy owner", () => {
    expect(durableDispatchTimeoutAction({ taskStatus: "assigned", isRedrive: false, hasExecutionClaim: false, ownerBusy: true })).toBe("defer");
    expect(durableDispatchTimeoutAction({ taskStatus: "assigned", isRedrive: true, hasExecutionClaim: false, ownerBusy: true })).toBe("defer");
  });

  it("defers instead of failing when the worker already claimed the task under an earlier handoff", () => {
    expect(durableDispatchTimeoutAction({ taskStatus: "running", isRedrive: true, hasExecutionClaim: true, ownerBusy: false })).toBe("defer");
    expect(durableDispatchTimeoutAction({ taskStatus: "assigned", isRedrive: false, hasExecutionClaim: true, ownerBusy: false })).toBe("defer");
  });

  it("still re-drives, fails, or ignores when nothing is executing or queued", () => {
    expect(durableDispatchTimeoutAction({ taskStatus: "assigned", isRedrive: false, hasExecutionClaim: false, ownerBusy: false })).toBe("redrive");
    expect(durableDispatchTimeoutAction({ taskStatus: "assigned", isRedrive: true, hasExecutionClaim: false, ownerBusy: false })).toBe("fail");
    expect(durableDispatchTimeoutAction({ taskStatus: "done", isRedrive: false, hasExecutionClaim: true, ownerBusy: true })).toBe("ignore");
    expect(durableDispatchTimeoutAction({ taskStatus: undefined, isRedrive: false, hasExecutionClaim: false, ownerBusy: false })).toBe("ignore");
  });

  it("defers the timeout decision while the workstream sits at a human gate", () => {
    expect(shouldDeferDispatchTimeout("waiting_for_human")).toBe(true);
    expect(shouldDeferDispatchTimeout("paused")).toBe(true);
    expect(shouldDeferDispatchTimeout("completing")).toBe(true);
    expect(shouldDeferDispatchTimeout("emergency_stopped")).toBe(true);
    expect(shouldDeferDispatchTimeout("active")).toBe(false);
    expect(shouldDeferDispatchTimeout("completed")).toBe(false);
    expect(shouldDeferDispatchTimeout(undefined)).toBe(false);
  });
});

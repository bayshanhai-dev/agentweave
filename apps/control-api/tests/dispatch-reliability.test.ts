import { describe, expect, it, vi } from "vitest";
import { armTriggerWatchdogForDispatch, durableDispatchTimeoutDecision, publishWithRetry, shouldArmDurableTaskWatchdog, shouldDeferDispatchTimeout, TriggerDispatchWatchdog } from "../src/dispatch-reliability.js";

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
});

describe("durable task dispatch recovery", () => {
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

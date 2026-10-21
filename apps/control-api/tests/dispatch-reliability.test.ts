import { describe, expect, it, vi } from "vitest";
import { publishWithRetry, TriggerDispatchWatchdog } from "../src/dispatch-reliability.js";

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

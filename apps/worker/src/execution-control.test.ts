import { describe, expect, it, vi } from "vitest";
import { ExecutionControl } from "./execution-control.js";

describe("ExecutionControl", () => {
  it("checkpoints and cancels on pause", async () => {
    const checkpoint = vi.fn(async () => undefined); const cancel = vi.fn(async () => undefined);
    const control = new ExecutionControl(); control.setHandlers({ checkpoint, cancel }); await control.update("paused");
    expect(control.current).toBe("paused"); expect(checkpoint).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects emergency stop", async () => { const control = new ExecutionControl(); await control.update("emergency_stopped"); expect(() => control.assertRunnable()).toThrow("stopped by operator"); });
});

import { describe, expect, it, vi } from "vitest";
import { ExecutionControl, ExecutionGatedError } from "../../src/runtime/execution-control.js";

describe("ExecutionControl", () => {
  it("checkpoints and cancels on pause", async () => {
    const checkpoint = vi.fn(async () => undefined); const cancel = vi.fn(async () => undefined);
    const control = new ExecutionControl(); control.setHandlers({ checkpoint, cancel }); await control.update("paused");
    expect(control.current).toBe("paused"); expect(checkpoint).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects emergency stop", async () => { const control = new ExecutionControl(); await control.update("emergency_stopped"); expect(() => control.assertRunnable()).toThrow("stopped by operator"); });
  it.each(["paused", "waiting_for_human"] as const)("throws a gated error (not a failure) while %s", async (status) => {
    const control = new ExecutionControl(); await control.update(status);
    let thrown: unknown;
    try { control.assertRunnable(); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(ExecutionGatedError);
    expect((thrown as ExecutionGatedError).state).toBe(status);
    expect((thrown as Error).message).toBe(`Execution is ${status}`);
  });
  it("does not throw a gated error for an emergency stop", async () => {
    const control = new ExecutionControl(); await control.update("emergency_stopped");
    expect(() => control.assertRunnable()).toThrowError(expect.not.objectContaining({ name: "ExecutionGatedError" }));
  });
});

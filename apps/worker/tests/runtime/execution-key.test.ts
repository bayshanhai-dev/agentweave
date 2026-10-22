import { describe, expect, it } from "vitest";
import { executionKeyForDelivery } from "../../src/runtime/execution-key.js";

describe("executionKeyForDelivery", () => {
  it("allows one business task to move across agents", () => {
    expect(executionKeyForDelivery("task-1", "pm-1", "handoff")).toBe("task-1:pm-1:handoff");
    expect(executionKeyForDelivery("task-1", "pe-2", "handoff")).toBe("task-1:pe-2:handoff");
  });

  it("keeps redeliveries to the same agent idempotent", () => {
    expect(executionKeyForDelivery("task-1", "pe-2", "handoff")).toBe(
      executionKeyForDelivery("task-1", "pe-2", "handoff"),
    );
  });

  it("allows an intentional re-drive to the same agent with a fresh handoff", () => {
    expect(executionKeyForDelivery("task-1", "pe-2", "handoff")).not.toBe(
      executionKeyForDelivery("task-1", "pe-2", "other-handoff"),
    );
  });
});

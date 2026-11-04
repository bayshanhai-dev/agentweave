import { describe, expect, it, vi } from "vitest";
import { reconcilePendingHumanMessagesOnBoot } from "../src/human-message-boot-recovery.js";

const humanMessage = (
  id: string,
  overrides: Partial<{
    senderId: string;
    recipientIds: string[];
    deliveryStatus: string;
    taskId: string;
    correlationId: string;
  }> = {},
) => ({
  id,
  senderId: "human",
  recipientIds: ["lead-1"],
  deliveryStatus: "delivered",
  correlationId: `human:${id}`,
  ...overrides,
});

describe("boot-time Human message recovery", () => {
  it("re-drives a delivered Human message loaded into fresh API state", async () => {
    const dispatch = vi.fn(async () => true);
    const emit = vi.fn();
    const workstream = {
      id: "ws-1",
      status: "active",
      agents: [{ id: "lead-1" }],
      messages: [humanMessage("legacy-instruction")],
    };

    const result = await reconcilePendingHumanMessagesOnBoot(workstream, {
      hasExecutionClaim: async () => false,
      dispatch,
      emit,
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      workstream.messages[0],
      ["lead-1"],
    );
    expect(result).toMatchObject({ scanned: 1, redriven: 1, skipped: 0 });
    expect(emit).toHaveBeenCalledWith(
      "message.dispatch_reconciled",
      expect.stringContaining("re-driven 1 (reused existing task 0); skipped 0"),
    );
  });

  it("is idempotent and reports every skip reason without touching Agent traffic", async () => {
    const claimedMessages = new Set(["already-turned"]);
    const dispatch = vi.fn(async (message: { id: string }) => {
      claimedMessages.add(message.id);
      return true;
    });
    const emit = vi.fn();
    const workstream = {
      id: "ws-1",
      status: "active",
      agents: [{ id: "lead-1" }],
      messages: [
        humanMessage("recover-me", { deliveryStatus: "pending" }),
        humanMessage("already-tasked", { taskId: "task-1" }),
        humanMessage("scheduled-trigger", {
          correlationId: "trigger:daily-owner-check:fire-1",
        }),
        humanMessage("already-turned"),
        humanMessage("human-endpoint", { recipientIds: ["human"] }),
        humanMessage("agent-traffic", { senderId: "lead-1" }),
      ],
    };
    const dependencies = {
      hasExecutionClaim: async (messageId: string) =>
        claimedMessages.has(messageId),
      dispatch,
      emit,
    };

    const first = await reconcilePendingHumanMessagesOnBoot(
      workstream,
      dependencies,
    );
    const second = await reconcilePendingHumanMessagesOnBoot(
      workstream,
      dependencies,
    );

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({
      scanned: 5,
      redriven: 2,
      redrivenWithExistingTask: 1,
      skipped: 3,
      skippedTriggerTraffic: 1,
      skippedDispatchedTurn: 1,
      skippedNoAgentRecipient: 1,
      ignoredNonHuman: 1,
    });
    expect(second).toMatchObject({
      scanned: 5,
      redriven: 0,
      skipped: 5,
      skippedTriggerTraffic: 1,
      skippedDispatchedTurn: 3,
      skippedNoAgentRecipient: 1,
      ignoredNonHuman: 1,
    });
    expect(emit).toHaveBeenLastCalledWith(
      "message.dispatch_reconciled",
      expect.stringContaining(
        "trigger traffic 1, dispatched turn 3, no Agent recipient 1",
      ),
    );
  });
});

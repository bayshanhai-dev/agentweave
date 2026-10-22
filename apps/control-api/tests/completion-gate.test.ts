import { describe, expect, it, vi } from "vitest";
import { reconcileCompletionGate } from "../src/completion-gate.js";

function fixture(statuses: string[] = ["done", "done"]) {
  const workstream = {
    status: "active",
    tasks: statuses.map((status, index) => ({
      id: `task-${index}`,
      title:
        index === statuses.length - 1
          ? "Final validation: run the full project suite"
          : `Implementation ${index}`,
      status,
    })),
    messages: [] as Array<{
      messageType: string;
      recipientIds: string[];
      deliveryStatus: string;
    }>,
    events: [
      {
        taskId: `task-${statuses.length - 1}`,
        message:
          "pnpm test\n54 passed, 0 failed\npnpm build\ncompleted successfully",
      },
    ],
  };
  const content: string[] = [];
  const dependencies = {
    createGate: vi.fn(async (summary: string) => {
      content.push(summary);
      workstream.messages.push({
        messageType: "decision",
        recipientIds: ["human"],
        deliveryStatus: "pending",
      });
    }),
    persistWaitingForHuman: vi.fn(async () => undefined),
    emit: vi.fn(),
  };
  return { workstream, dependencies, content };
}

describe("completion gate reconciliation", () => {
  it("creates a held completion decision and waits for Human when every task is terminal", async () => {
    const { workstream, dependencies, content } = fixture();

    expect(await reconcileCompletionGate(workstream, dependencies)).toBe(true);
    expect(workstream.status).toBe("waiting_for_human");
    expect(dependencies.createGate).toHaveBeenCalledOnce();
    expect(content[0]).toContain(
      "Final validation reported result (verbatim):",
    );
    expect(content[0]).toContain("pnpm test\n54 passed, 0 failed");
    expect(dependencies.emit).toHaveBeenCalledWith(
      "workstream.completion_proposed",
      expect.stringContaining("Human completion decision required"),
    );
  });

  it("self-heals a persisted active all-terminal workstream with no gate", async () => {
    const { workstream, dependencies } = fixture([
      "done",
      "cancelled",
      "failed",
    ]);

    expect(await reconcileCompletionGate(workstream, dependencies)).toBe(true);
    expect(dependencies.persistWaitingForHuman).toHaveBeenCalledOnce();
    expect(workstream.messages).toContainEqual({
      messageType: "decision",
      recipientIds: ["human"],
      deliveryStatus: "pending",
    });
  });

  it.each(["ready", "assigned", "running", "review", "blocked"])(
    "does not create the completion gate while a task is %s",
    async (status) => {
      const { workstream, dependencies } = fixture(["done", status]);

      expect(await reconcileCompletionGate(workstream, dependencies)).toBe(
        false,
      );
      expect(workstream.status).toBe("active");
      expect(dependencies.createGate).not.toHaveBeenCalled();
    },
  );

  it("does not duplicate an existing pending Human decision", async () => {
    const { workstream, dependencies } = fixture();
    workstream.messages.push({
      messageType: "decision",
      recipientIds: ["human"],
      deliveryStatus: "pending",
    });

    expect(await reconcileCompletionGate(workstream, dependencies)).toBe(false);
    expect(dependencies.createGate).not.toHaveBeenCalled();
  });
});

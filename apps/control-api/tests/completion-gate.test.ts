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
        type: "orchestration.implementation_triggered",
        message: "PM prompted to decompose synthesis into implementation tasks",
      },
      {
        type: "task.decomposition.persisted",
        message: `${statuses.length} durable tasks created from PM output`,
      },
      {
        type: "task.completed",
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
  it("proposes completion after decomposition persisted and every task is terminal", async () => {
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

  it("does not propose completion after the run 18 decomposition failure and re-prompt", async () => {
    const { workstream, dependencies } = fixture([
      "done",
      "done",
      "done",
      "done",
      "failed",
    ]);
    workstream.status = "waiting_for_human";
    workstream.tasks[4]!.title = "Implementation decomposition";
    workstream.events = [
      {
        type: "collaboration.round.completed",
        message: "Collaboration completed",
      },
      {
        type: "orchestration.implementation_triggered",
        message: "PM prompted before approval",
      },
      {
        type: "task.failed",
        taskId: "task-4",
        message: "pm → Execution is waiting_for_human",
      },
      {
        type: "orchestration.decomposition_reprompted",
        message: "PM decomposition re-prompted (attempt 1)",
      },
    ];

    expect(await reconcileCompletionGate(workstream, dependencies)).toBe(false);
    workstream.status = "active";
    expect(await reconcileCompletionGate(workstream, dependencies)).toBe(false);
    expect(dependencies.createGate).not.toHaveBeenCalled();
    expect(dependencies.emit).not.toHaveBeenCalledWith(
      "workstream.completion_proposed",
      expect.any(String),
    );
    expect(workstream.events.at(-1)?.type).toBe(
      "orchestration.decomposition_reprompted",
    );
  });

  it("does not propose completion without persisted decomposition evidence", async () => {
    const { workstream, dependencies } = fixture();
    workstream.events = workstream.events.filter(
      (event) => event.type !== "task.decomposition.persisted",
    );

    expect(await reconcileCompletionGate(workstream, dependencies)).toBe(false);
    expect(dependencies.createGate).not.toHaveBeenCalled();
  });

  it("does not propose completion while a failed decomposition awaits re-drive", async () => {
    const { workstream, dependencies } = fixture(["failed", "done"]);
    workstream.tasks[0]!.title = "Implementation decomposition";
    workstream.events.push({
      type: "task.failed",
      taskId: "task-0",
      message: "Implementation decomposition failed",
    });

    expect(await reconcileCompletionGate(workstream, dependencies)).toBe(false);
    expect(dependencies.createGate).not.toHaveBeenCalled();
  });

  it("does not propose completion while final validation is still running", async () => {
    const { workstream, dependencies } = fixture(["done", "running"]);

    expect(await reconcileCompletionGate(workstream, dependencies)).toBe(false);
    expect(dependencies.createGate).not.toHaveBeenCalled();
  });

  it("does not reuse an earlier cycle's decomposition after a new trigger", async () => {
    const { workstream, dependencies } = fixture();
    workstream.events.push({
      type: "orchestration.implementation_triggered",
      message: "A new implementation cycle started",
    });

    expect(await reconcileCompletionGate(workstream, dependencies)).toBe(false);
    expect(dependencies.createGate).not.toHaveBeenCalled();
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

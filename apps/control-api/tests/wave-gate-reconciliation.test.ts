import { describe, expect, it, vi } from "vitest";
import { withFinalValidationTask } from "../src/final-validation.js";
import {
  reconcileDispatchableTasks,
  reconcileWaveGateAfterActivation,
} from "../src/wave-gate-reconciliation.js";

const policy = {
  templateId: "software-development",
  leadRole: "pm",
  planningRole: "pe",
  executionRoles: ["backend", "frontend"],
  reviewRole: "qa",
};

function waveFixture(status = "active") {
  const agents = [
    { id: "pm-1", role: "pm" },
    { id: "backend-1", role: "backend" },
    { id: "frontend-1", role: "frontend" },
  ];
  const firstWave = ["wave-1-backend", "wave-1-frontend"].map((id) => ({
    id,
    title: id,
    status: "done",
    ownerAgentId: id.endsWith("backend") ? "backend-1" : "frontend-1",
    createdByAgentId: "pm-1",
    acceptanceCriteria: ["Wave one is complete"],
    dependencies: [],
  }));
  const secondWave = ["api", "ui", "tests", "docs"].map((name, index) => ({
    id: `wave-2-${name}`,
    title: `Implement ${name}`,
    status: "assigned",
    ownerAgentId: index % 2 === 0 ? "backend-1" : "frontend-1",
    createdByAgentId: "pm-1",
    acceptanceCriteria: [`${name} is complete`],
    dependencies: firstWave.map((task) => task.id),
  }));
  const gate = {
    id: "gate-decision",
    senderId: "pm-1",
    recipientIds: ["human"],
    messageType: "decision",
    deliveryStatus: "pending",
  };
  const workstream = {
    id: "ws-1",
    status,
    agents,
    tasks: [...firstWave, ...secondWave],
    messages: [gate],
  };
  const dispatched: Array<{
    senderId: string;
    recipientId: string;
    content: string;
    taskId: string;
    causationId?: string;
  }> = [];
  const acknowledgeGateMessage = vi.fn(async (message: typeof gate) => {
    message.deliveryStatus = "acknowledged";
    return true;
  });
  const dispatchTask = vi.fn(async (input: (typeof dispatched)[number]) => {
    dispatched.push(input);
    workstream.messages.push({
      id: `request-${input.taskId}`,
      senderId: input.senderId,
      recipientIds: [input.recipientId],
      messageType: "request",
      taskId: input.taskId,
      deliveryStatus: "delivered",
    });
    return { deliveryStatus: "delivered" };
  });
  return {
    workstream,
    secondWave,
    gate,
    dispatched,
    dependencies: {
      acknowledgeGateMessage,
      hasExecutionClaim: vi.fn(async () => false),
      dispatchTask,
      emit: vi.fn(),
    },
  };
}

function finalValidationFixture() {
  const agents = [
    { id: "pm-1", role: "pm" },
    { id: "backend-1", role: "backend" },
    { id: "frontend-1", role: "frontend" },
    { id: "qa-1", role: "qa" },
  ];
  const specs = withFinalValidationTask([
    { title: "Build the API", ownerRole: "backend" },
    { title: "Build the UI", ownerRole: "frontend" },
    { title: "Write the docs", ownerRole: "backend" },
  ]);
  const taskIds = specs.map((_, index) => `task-${index + 1}`);
  const tasks = specs.map((spec, index) => ({
    id: taskIds[index]!,
    title: spec.title,
    status: "assigned",
    ownerAgentId: agents.find((agent) => agent.role === spec.ownerRole)?.id,
    createdByAgentId: "pm-1",
    acceptanceCriteria: spec.acceptanceCriteria ?? [],
    dependencies: spec.dependsOnAllPrevious
      ? taskIds.slice(0, index)
      : (spec.dependencies ?? []),
  }));
  const validationTask = tasks.at(-1)!;
  const implementationTasks = tasks.slice(0, -1);
  const workstream = {
    id: "ws-final-validation",
    status: "active",
    agents,
    tasks,
    messages: implementationTasks.map((task) => ({
      id: `request-${task.id}`,
      senderId: "pm-1",
      recipientIds: [task.ownerAgentId!],
      messageType: "request",
      taskId: task.id,
      deliveryStatus: "delivered",
    })),
  };
  const dispatchTask = vi.fn(
    async (input: {
      senderId: string;
      recipientId: string;
      content: string;
      taskId: string;
      causationId?: string;
    }) => {
      workstream.messages.push({
        id: `request-${input.taskId}`,
        senderId: input.senderId,
        recipientIds: [input.recipientId],
        messageType: "request",
        taskId: input.taskId,
        deliveryStatus: "delivered",
      });
      return { deliveryStatus: "delivered" };
    },
  );

  return {
    workstream,
    implementationTasks,
    validationTask,
    dependencies: {
      hasExecutionClaim: vi.fn(async () => false),
      dispatchTask,
      emit: vi.fn(),
    },
  };
}

describe("wave gate activation reconciliation", () => {
  it("leaves collaboration tasks to the round-aware reconciler", async () => {
    const fixture = waveFixture();
    const task = fixture.secondWave[0]!;
    task.title = "[Collaboration:proposal] Independent proposal from backend";
    task.dependencies = [];
    fixture.workstream.tasks = [task];

    const result = await reconcileWaveGateAfterActivation(
      fixture.workstream,
      policy,
      fixture.dependencies,
    );

    expect(result.dispatchedTaskIds).toEqual([]);
    expect(fixture.dependencies.dispatchTask).not.toHaveBeenCalled();
  });

  it("holds the next wave before approval, then releases the gate and delivers its task requests after resume", async () => {
    const fixture = waveFixture("waiting_for_human");

    expect(
      await reconcileWaveGateAfterActivation(
        fixture.workstream,
        policy,
        fixture.dependencies,
      ),
    ).toEqual({ releasedGateMessageIds: [], dispatchedTaskIds: [] });
    expect(fixture.gate.deliveryStatus).toBe("pending");
    expect(fixture.dependencies.dispatchTask).not.toHaveBeenCalled();

    fixture.workstream.status = "active";
    const resumed = await reconcileWaveGateAfterActivation(
      fixture.workstream,
      policy,
      fixture.dependencies,
    );

    expect(resumed.releasedGateMessageIds).toEqual(["gate-decision"]);
    expect(fixture.gate.deliveryStatus).toBe("acknowledged");
    expect(resumed.dispatchedTaskIds).toEqual(
      fixture.secondWave.map((task) => task.id),
    );
    expect(fixture.dispatched).toHaveLength(4);
    expect(
      fixture.dispatched.every(
        (dispatch) => dispatch.causationId === "gate-decision",
      ),
    ).toBe(true);
    expect(
      fixture.dispatched.every((dispatch) =>
        dispatch.content.includes(
          "Continue the workstream after Human approval",
        ),
      ),
    ).toBe(true);
    expect(
      fixture.workstream.messages
        .filter(
          (message) =>
            message.messageType === "request" &&
            message.deliveryStatus === "delivered",
        )
        .map((message) => message.taskId),
    ).toEqual(fixture.secondWave.map((task) => task.id));
  });

  it.each(["pending", "delivered"])(
    "does not double-dispatch a task with an existing %s delivery",
    async (deliveryStatus) => {
      const fixture = waveFixture();
      const task = fixture.secondWave[0]!;
      fixture.workstream.tasks = [
        ...fixture.workstream.tasks.filter(
          (candidate) => candidate.status === "done",
        ),
        task,
      ];
      fixture.workstream.messages.push({
        id: "existing-request",
        senderId: "pm-1",
        recipientIds: [task.ownerAgentId!],
        messageType: "request",
        taskId: task.id,
        deliveryStatus,
      });

      const result = await reconcileWaveGateAfterActivation(
        fixture.workstream,
        policy,
        fixture.dependencies,
      );

      expect(result.dispatchedTaskIds).toEqual([]);
      expect(fixture.dependencies.dispatchTask).not.toHaveBeenCalled();
    },
  );

  it("does not resurrect a delivery that already has a persisted worker claim", async () => {
    const fixture = waveFixture();
    const task = fixture.secondWave[0]!;
    fixture.workstream.tasks = [
      ...fixture.workstream.tasks.filter(
        (candidate) => candidate.status === "done",
      ),
      task,
    ];
    fixture.dependencies.hasExecutionClaim.mockResolvedValue(true);

    const result = await reconcileWaveGateAfterActivation(
      fixture.workstream,
      policy,
      fixture.dependencies,
    );

    expect(result.dispatchedTaskIds).toEqual([]);
    expect(fixture.dependencies.dispatchTask).not.toHaveBeenCalled();
  });

  it("re-dispatches a gated assigned task after resume while ignoring its interrupted claim", async () => {
    const fixture = waveFixture("waiting_for_human");
    const task = fixture.secondWave[0]!;
    task.dependencies = [];
    fixture.workstream.tasks = [task];
    fixture.workstream.events = [{
      type: "task.gated",
      taskId: task.id,
      occurredAt: "2026-10-23T23:18:46.000Z",
    }];
    fixture.dependencies.hasExecutionClaim.mockImplementation(async (_taskId, startedAfter) => !startedAfter);

    fixture.workstream.status = "active";
    const result = await reconcileWaveGateAfterActivation(
      fixture.workstream,
      policy,
      fixture.dependencies,
    );

    expect(fixture.dependencies.hasExecutionClaim).toHaveBeenCalledWith(
      task.id,
      "2026-10-23T23:18:46.000Z",
    );
    expect(result.dispatchedTaskIds).toEqual([task.id]);
    expect(fixture.dependencies.dispatchTask).toHaveBeenCalledOnce();
  });
});

function staleHandoffFixture(
  options: { deliveryAgeMs?: number; ownerStatus?: string; claimed?: boolean } = {},
) {
  const now = 1_800_000_000_000;
  const agents = [
    { id: "pm-1", role: "pm" },
    { id: "backend-1", role: "backend", status: options.ownerStatus ?? "idle" },
  ];
  const task = {
    id: "task-stale",
    title: "Implement the thing",
    status: "assigned",
    ownerAgentId: "backend-1",
    createdByAgentId: "pm-1",
    acceptanceCriteria: ["It works"],
    dependencies: [] as string[],
  };
  const staleMessage = {
    id: "request-stale",
    senderId: "pm-1",
    recipientIds: ["backend-1"],
    messageType: "request",
    taskId: task.id,
    deliveryStatus: "delivered",
    createdAt: new Date(now - (options.deliveryAgeMs ?? 600_000)).toISOString(),
  };
  const workstream = {
    id: "ws-stale",
    status: "active",
    agents,
    tasks: [task],
    messages: [staleMessage] as Array<Record<string, unknown>>,
  };
  const closeStaleDelivery = vi.fn(
    async (message: { deliveryStatus: string }) => {
      message.deliveryStatus = "failed";
      return true;
    },
  );
  const dispatchTask = vi.fn(
    async (input: {
      senderId: string;
      recipientId: string;
      content: string;
      taskId: string;
      causationId?: string;
    }) => {
      workstream.messages.push({
        id: `request-fresh-${input.taskId}`,
        senderId: input.senderId,
        recipientIds: [input.recipientId],
        messageType: "request",
        taskId: input.taskId,
        deliveryStatus: "delivered",
        createdAt: new Date(now).toISOString(),
      });
      return { deliveryStatus: "delivered" };
    },
  );
  return {
    workstream,
    task,
    staleMessage,
    dependencies: {
      hasExecutionClaim: vi.fn(async () => options.claimed ?? false),
      dispatchTask,
      emit: vi.fn(),
      closeStaleDelivery,
      now: () => now,
    },
  };
}

describe("stale handoff recovery", () => {
  it("closes a stale handoff and re-dispatches when the owner is idle and unclaimed", async () => {
    const fixture = staleHandoffFixture();

    const dispatched = await reconcileDispatchableTasks(
      fixture.workstream as never,
      policy,
      fixture.dependencies as never,
    );

    expect(dispatched).toEqual([fixture.task.id]);
    expect(fixture.dependencies.closeStaleDelivery).toHaveBeenCalledOnce();
    expect(fixture.staleMessage.deliveryStatus).toBe("failed");
    expect(fixture.dependencies.dispatchTask).toHaveBeenCalledOnce();
  });

  it("leaves a stale handoff alone while the owner agent is busy", async () => {
    const fixture = staleHandoffFixture({ ownerStatus: "running" });

    const dispatched = await reconcileDispatchableTasks(
      fixture.workstream as never,
      policy,
      fixture.dependencies as never,
    );

    expect(dispatched).toEqual([]);
    expect(fixture.dependencies.closeStaleDelivery).not.toHaveBeenCalled();
    expect(fixture.dependencies.dispatchTask).not.toHaveBeenCalled();
  });

  it("leaves a fresh handoff alone even when the owner is idle", async () => {
    const fixture = staleHandoffFixture({ deliveryAgeMs: 60_000 });

    const dispatched = await reconcileDispatchableTasks(
      fixture.workstream as never,
      policy,
      fixture.dependencies as never,
    );

    expect(dispatched).toEqual([]);
    expect(fixture.dependencies.closeStaleDelivery).not.toHaveBeenCalled();
    expect(fixture.dependencies.dispatchTask).not.toHaveBeenCalled();
  });

  it("leaves a stale handoff alone when a worker claim already exists", async () => {
    const fixture = staleHandoffFixture({ claimed: true });

    const dispatched = await reconcileDispatchableTasks(
      fixture.workstream as never,
      policy,
      fixture.dependencies as never,
    );

    expect(dispatched).toEqual([]);
    expect(fixture.dependencies.closeStaleDelivery).not.toHaveBeenCalled();
    expect(fixture.dependencies.dispatchTask).not.toHaveBeenCalled();
  });

  it("does not re-drive without a closeStaleDelivery dependency", async () => {
    const fixture = staleHandoffFixture();
    const { closeStaleDelivery: _omitted, ...dependencies } = fixture.dependencies;

    const dispatched = await reconcileDispatchableTasks(
      fixture.workstream as never,
      policy,
      dependencies as never,
    );

    expect(dispatched).toEqual([]);
    expect(fixture.dependencies.dispatchTask).not.toHaveBeenCalled();
    expect(fixture.staleMessage.deliveryStatus).toBe("delivered");
  });
});

describe("terminal task dispatch reconciliation", () => {
  it("dispatches appended final validation after the last implementation task completes", async () => {
    const fixture = finalValidationFixture();

    for (const [index, task] of fixture.implementationTasks.entries()) {
      task.status = "done";
      const dispatched = await reconcileDispatchableTasks(
        fixture.workstream,
        policy,
        fixture.dependencies,
      );
      expect(dispatched).toEqual(
        index === fixture.implementationTasks.length - 1
          ? [fixture.validationTask.id]
          : [],
      );
    }

    expect(
      fixture.workstream.messages.some(
        (message) =>
          message.taskId === fixture.validationTask.id &&
          message.messageType === "request" &&
          message.deliveryStatus === "delivered",
      ),
    ).toBe(true);
  });

  it("does not dispatch final validation when a non-final dependency completes", async () => {
    const fixture = finalValidationFixture();
    fixture.implementationTasks[0]!.status = "done";

    const dispatched = await reconcileDispatchableTasks(
      fixture.workstream,
      policy,
      fixture.dependencies,
    );

    expect(dispatched).toEqual([]);
    expect(fixture.dependencies.dispatchTask).not.toHaveBeenCalled();
  });

  it("holds final validation while a later review task is still running, then dispatches it", async () => {
    const fixture = finalValidationFixture();
    const reviewTask = {
      id: "review-extra",
      title: "Review: Build the API",
      status: "running",
      ownerAgentId: "qa-1",
      createdByAgentId: "pm-1",
      acceptanceCriteria: ["Review passes"],
      dependencies: [],
    };
    fixture.workstream.tasks.push(reviewTask);
    for (const task of fixture.implementationTasks) task.status = "done";

    const held = await reconcileDispatchableTasks(
      fixture.workstream,
      policy,
      fixture.dependencies,
    );
    expect(held).toEqual([]);
    expect(fixture.dependencies.dispatchTask).not.toHaveBeenCalled();

    reviewTask.status = "done";
    const dispatched = await reconcileDispatchableTasks(
      fixture.workstream,
      policy,
      fixture.dependencies,
    );
    expect(dispatched).toEqual([fixture.validationTask.id]);
  });

  it("does not duplicate final validation when it already has an in-flight delivery", async () => {
    const fixture = finalValidationFixture();
    for (const task of fixture.implementationTasks) task.status = "done";
    fixture.workstream.messages.push({
      id: "existing-validation-request",
      senderId: "pm-1",
      recipientIds: [fixture.validationTask.ownerAgentId!],
      messageType: "request",
      taskId: fixture.validationTask.id,
      deliveryStatus: "delivered",
    });

    const dispatched = await reconcileDispatchableTasks(
      fixture.workstream,
      policy,
      fixture.dependencies,
    );

    expect(dispatched).toEqual([]);
    expect(fixture.dependencies.dispatchTask).not.toHaveBeenCalled();
  });
});

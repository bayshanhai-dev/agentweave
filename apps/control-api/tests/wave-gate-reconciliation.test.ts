import { describe, expect, it, vi } from "vitest";
import { reconcileWaveGateAfterActivation } from "../src/wave-gate-reconciliation.js";

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

describe("wave gate activation reconciliation", () => {
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
});

import { describe, expect, it, vi } from "vitest";
import {
  implementationTriggerInstructionSeparator,
  republishImplementationTriggerAfterResume,
} from "../src/approval-implementation-trigger.js";

const completedRound = {
  id: "round-1",
  workstreamId: "ws-1",
  topic: "topic",
  participantAgentIds: ["pm-1"],
  synthesizerAgentId: "pm-1",
  maxTurns: 3,
  deadline: new Date().toISOString(),
  completionRule: "synthesizer" as const,
  status: "completed" as const,
  insightIds: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function fixture(
  tasks: Array<{ title: string }> = [],
  content = `[agentweave implementation-trigger] synthesis${implementationTriggerInstructionSeparator} old instruction`,
) {
  const workstream = {
    id: "ws-1",
    tasks,
    events: [] as Array<{ type: string; occurredAt: string }>,
    messages: [
      {
        id: "trigger-1",
        senderId: "human",
        recipientIds: ["pm-1"],
        messageType: "directive",
        content,
        createdAt: "2026-01-01T00:00:00.000Z",
        causationId: undefined as string | undefined,
      },
    ],
  };
  const emit = vi.fn();
  const createMessage = vi.fn(async (senderId, recipientIds, content, messageType, causationId) => {
    workstream.messages.push({
      id: "trigger-2",
      senderId,
      recipientIds,
      messageType,
      content,
      createdAt: `2026-01-01T00:00:0${workstream.messages.length}.000Z`,
      causationId,
    });
  });
  return {
    workstream,
    dependencies: {
      listRounds: vi.fn(async () => [completedRound]),
      createMessage,
      emit,
    },
    createMessage,
    emit,
  };
}

describe("approval implementation trigger recovery", () => {
  it("publishes a first copy with the new instruction tail", async () => {
    const { workstream, dependencies, createMessage, emit } = fixture();

    expect(await republishImplementationTriggerAfterResume(workstream, dependencies)).toBe(true);

    expect(createMessage).toHaveBeenCalledOnce();
    const content = createMessage.mock.calls[0]?.[2];
    expect(content).toContain("[READY_FOR_DECOMPOSITION]");
    expect(content).toContain("- [role] Task title");
    expect(content).not.toContain("orchestration-decision");
    expect(createMessage.mock.calls[0]?.[4]).toBe("trigger-1");
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      "orchestration.implementation_triggered",
      "PM prompted to decompose synthesis into implementation tasks",
      "human",
    );
  });

  it("does not publish a second copy without a later task failure", async () => {
    const { workstream, dependencies, createMessage } = fixture();
    expect(await republishImplementationTriggerAfterResume(workstream, dependencies)).toBe(true);
    createMessage.mockClear();

    expect(await republishImplementationTriggerAfterResume(workstream, dependencies)).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("publishes a fresh copy after the previous copy's turn fails", async () => {
    const { workstream, dependencies, createMessage } = fixture();
    expect(await republishImplementationTriggerAfterResume(workstream, dependencies)).toBe(true);
    workstream.events.push({ type: "task.failed", occurredAt: "2026-01-01T00:00:02.000Z" });
    createMessage.mockClear();

    expect(await republishImplementationTriggerAfterResume(workstream, dependencies)).toBe(true);
    const content = createMessage.mock.calls[0]?.[2];
    expect(createMessage.mock.calls[0]?.[4]).toBe("trigger-2");
    expect(content).toContain("[READY_FOR_DECOMPOSITION]");
    expect(content).toContain("- [role] Task title");
    expect(content).not.toContain("old instruction");
  });

  it("clones content without the separator verbatim", async () => {
    const originalContent = "[agentweave implementation-trigger] implement the synthesis";
    const { workstream, dependencies, createMessage } = fixture([], originalContent);

    expect(await republishImplementationTriggerAfterResume(workstream, dependencies)).toBe(true);
    expect(createMessage.mock.calls[0]?.[2]).toBe(originalContent);
  });

  it("does not republish when implementation tasks already exist", async () => {
    const { workstream, dependencies, createMessage, emit } = fixture([
      { title: "Implement the API" },
    ]);

    expect(await republishImplementationTriggerAfterResume(workstream, dependencies)).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

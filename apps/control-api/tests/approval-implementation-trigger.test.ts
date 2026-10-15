import { describe, expect, it, vi } from "vitest";
import { republishImplementationTriggerAfterResume } from "../src/approval-implementation-trigger.js";

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

function fixture(tasks: Array<{ title: string }> = []) {
  const workstream = {
    id: "ws-1",
    tasks,
    messages: [
      {
        id: "trigger-1",
        senderId: "human",
        recipientIds: ["pm-1"],
        messageType: "directive",
        content: "[agentweave implementation-trigger] implement the synthesis",
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
  it("republishes a completed-round trigger exactly once across resumes", async () => {
    const { workstream, dependencies, createMessage, emit } = fixture();

    expect(await republishImplementationTriggerAfterResume(workstream, dependencies)).toBe(true);
    expect(await republishImplementationTriggerAfterResume(workstream, dependencies)).toBe(false);

    expect(createMessage).toHaveBeenCalledOnce();
    expect(createMessage).toHaveBeenCalledWith(
      "human",
      ["pm-1"],
      "[agentweave implementation-trigger] implement the synthesis",
      "directive",
      "trigger-1",
    );
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      "orchestration.implementation_triggered",
      "PM prompted to decompose synthesis into implementation tasks",
      "human",
    );
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

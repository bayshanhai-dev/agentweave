import { describe, expect, it } from "vitest";
import { cardWorked, computeAgentCards } from "../src/agentCards";

const agents = [
  { id: "ws:backend-1", role: "backend", status: "idle" },
  { id: "ws:devops-1", role: "devops", status: "idle" },
];

describe("agent cards work history", () => {
  it("credits completed tasks and last activity to the agent that did them", () => {
    const cards = computeAgentCards(
      agents,
      [
        {
          id: "e1",
          type: "turn.completed",
          agentId: "ws:backend-1",
          occurredAt: "2026-10-23T10:00:00Z",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
      ],
      undefined,
      [
        { status: "done", ownerAgentId: "ws:backend-1" },
        { status: "done", ownerAgentId: "ws:backend-1" },
        { status: "running", ownerAgentId: "ws:backend-1" },
        { status: "done", ownerAgentId: "ws:qa-9" },
      ],
    );
    const backend = cards.find((card) => card.role === "backend")!;
    expect(backend.tasksDone).toBe(2);
    expect(backend.lastActiveAt).toBe("2026-10-23T10:00:00Z");
    expect(cardWorked(backend)).toBe(true);

    const devops = cards.find((card) => card.role === "devops")!;
    expect(devops.tasksDone).toBe(0);
    expect(devops.lastActiveAt).toBeUndefined();
    expect(cardWorked(devops)).toBe(false);
  });

  it("matches tasks to agents by role segment when ids differ", () => {
    const cards = computeAgentCards(agents, [], undefined, [
      { status: "done", ownerAgentId: "other-ws:backend-7" },
    ]);
    expect(cards.find((card) => card.role === "backend")!.tasksDone).toBe(1);
  });
});

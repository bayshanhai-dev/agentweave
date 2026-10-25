import { describe, expect, it } from "vitest";
import { detectWorkstreamStall } from "../src/stall-detection.js";

const now = Date.parse("2026-10-25T12:00:00.000Z");

function fixture() {
  return {
    status: "active",
    tasks: [
      { id: "ready", status: "ready" },
      { id: "assigned", status: "assigned", ownerAgentId: "pm-1" },
      { id: "running", status: "running", ownerAgentId: "backend-1" },
    ],
    messages: [{ taskId: "running", deliveryStatus: "delivered" }],
    events: [
      {
        id: "event-old",
        type: "task.created",
        occurredAt: "2026-10-25T11:49:00.000Z",
      },
    ],
  };
}

describe("workstream stall detection", () => {
  it("fires for a quiet active workstream and summarizes its blockers", () => {
    const decision = detectWorkstreamStall(fixture(), undefined, now);

    expect(decision).toMatchObject({
      episodeKey: "event-old",
      taskCounts: { ready: 1, assigned: 1, running: 1 },
      ownerlessTasks: 1,
      assignedButUndispatchedTasks: 1,
    });
    expect(decision?.message).toContain("assigned=1, ready=1, running=1");
  });

  it("stays silent for terminal-only or recently active workstreams", () => {
    const terminal = fixture();
    terminal.tasks = [{ id: "done", status: "done", ownerAgentId: "pm-1" }];
    expect(detectWorkstreamStall(terminal, undefined, now)).toBeUndefined();

    const recent = fixture();
    recent.events[0]!.occurredAt = "2026-10-25T11:55:00.000Z";
    expect(detectWorkstreamStall(recent, undefined, now)).toBeUndefined();
  });

  it("emits once per quiet episode and re-arms after a new event", () => {
    const workstream = fixture();
    const first = detectWorkstreamStall(workstream, undefined, now)!;
    expect(
      detectWorkstreamStall(workstream, first.episodeKey, now + 60_000),
    ).toBeUndefined();

    workstream.events.push({
      id: "event-new",
      type: "task.updated",
      occurredAt: new Date(now + 60_000).toISOString(),
    });
    expect(
      detectWorkstreamStall(workstream, first.episodeKey, now + 2 * 60_000),
    ).toBeUndefined();
    expect(
      detectWorkstreamStall(workstream, first.episodeKey, now + 12 * 60_000),
    )?.toMatchObject({ episodeKey: "event-new" });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { transitionAgentStatus, type AgentStatusEvent } from "../src/agent-status.js";

afterEach(() => {
  delete process.env.AGENT_FSM_ENFORCE;
});

function dependencies(events: AgentStatusEvent[], writes: string[]) {
  return {
    persist: async (agentId: string, status: "idle" | "running" | "paused" | "stopped" | "failed" | "done") => {
      writes.push(`${agentId}:${status}`);
    },
    emit: (event: AgentStatusEvent) => { events.push(event); },
  };
}

describe("agent status transition entry point", () => {
  it("persists a valid transition and emits its auditable payload", async () => {
    const agent = { id: "agent-1", status: "idle" as const };
    const events: AgentStatusEvent[] = [];
    const writes: string[] = [];

    const result = await transitionAgentStatus(agent, "running", {
      reason: "turn_started",
      taskId: "task-1",
      turnId: "turn-1",
    }, dependencies(events, writes));

    expect(result).toMatchObject({ valid: true, applied: true, rejected: false });
    expect(agent.status).toBe("running");
    expect(writes).toEqual(["agent-1:running"]);
    expect(events).toEqual([expect.objectContaining({
      type: "agent.status_changed",
      agentId: "agent-1",
      payload: { from: "idle", to: "running", reason: "turn_started", taskId: "task-1", turnId: "turn-1" },
    })]);
  });

  it("records an invalid transition but applies it in observe mode", async () => {
    const agent = { id: "agent-1", status: "paused" as const };
    const events: AgentStatusEvent[] = [];
    const writes: string[] = [];

    const result = await transitionAgentStatus(agent, "running", { reason: "late_turn_event" }, dependencies(events, writes));

    expect(result).toMatchObject({ valid: false, applied: true, rejected: true });
    expect(agent.status).toBe("running");
    expect(writes).toEqual(["agent-1:running"]);
    expect(events.map((event) => event.type)).toEqual([
      "agent.transition_rejected",
      "agent.status_changed",
    ]);
    expect(events[0]?.payload).toEqual({ from: "paused", to: "running", reason: "late_turn_event" });
  });

  it("does not persist an invalid transition when enforcement is enabled", async () => {
    process.env.AGENT_FSM_ENFORCE = "true";
    const agent = { id: "agent-1", status: "done" as const };
    const events: AgentStatusEvent[] = [];
    const writes: string[] = [];

    const result = await transitionAgentStatus(agent, "idle", { reason: "dispatch" }, dependencies(events, writes));

    expect(result).toMatchObject({ valid: false, applied: false, rejected: true });
    expect(agent.status).toBe("done");
    expect(writes).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ type: "agent.transition_rejected" })]);
  });
});

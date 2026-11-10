import { describe, expect, it } from "vitest";
import { orphanedRunningAgents, staleTurns, turnKey } from "../src/turn-watchdog.js";

describe("turn watchdog", () => {
  it("finds a turn whose heartbeat has gone stale", () => {
    const turn = { key: "turn-1", agentId: "agent-1", lastSignalAt: 1000 };
    expect(staleTurns([turn], 121_000, 120_000)).toEqual([turn]);
    expect(staleTurns([turn], 120_999, 120_000)).toEqual([]);
  });

  it("identifies running agents with no live turn", () => {
    expect(orphanedRunningAgents([
      { id: "agent-1", status: "running" },
      { id: "agent-2", status: "idle" },
    ], new Set())).toEqual([{ id: "agent-1", status: "running" }]);
  });

  it("keeps the tracker identity stable across broker retries", () => {
    expect(turnKey({ workstreamId: "ws", agentId: "agent", correlationId: "corr" })).toBe("ws:agent:corr");
  });
});

import { describe, expect, it } from "vitest";
import { orphanedRunningAgents, reconstructLiveTurn, staleTurns, turnKey } from "../src/turn-watchdog.js";

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

  describe("reconstructLiveTurn", () => {
    const event = (type: string, agentId: string, occurredAt: string, extra: Record<string, string> = {}) => ({
      type,
      agentId,
      occurredAt,
      ...extra,
    });

    it("returns the newest signal with no later terminal event for its agent", () => {
      const events = [
        event("run.started", "agent-1", "2026-11-10T10:00:00Z", { correlationId: "c1" }),
        event("turn.delta", "agent-1", "2026-11-10T10:00:10Z", { correlationId: "c1", taskId: "t1" }),
        event("turn.completed", "agent-1", "2026-11-10T10:00:20Z"),
        event("turn.delta", "agent-1", "2026-11-10T10:01:00Z", { correlationId: "c2", taskId: "t2" }),
      ];
      expect(reconstructLiveTurn("ws", events)).toEqual({
        key: "ws:agent-1:c2",
        agentId: "agent-1",
        taskId: "t2",
        lastSignalAt: Date.parse("2026-11-10T10:01:00Z"),
      });
    });

    it("returns undefined when every turn completed", () => {
      const events = [
        event("turn.delta", "agent-1", "2026-11-10T10:00:10Z", { correlationId: "c1" }),
        event("turn.completed", "agent-1", "2026-11-10T10:00:20Z"),
        event("turn.delta", "agent-2", "2026-11-10T10:00:30Z", { correlationId: "c2" }),
        event("task.completed", "agent-2", "2026-11-10T10:00:40Z"),
      ];
      expect(reconstructLiveTurn("ws", events)).toBeUndefined();
    });

    it("picks the newest unterminated signal across agents", () => {
      const events = [
        event("turn.delta", "agent-1", "2026-11-10T10:00:10Z", { correlationId: "c1" }),
        event("turn.delta", "agent-2", "2026-11-10T10:00:20Z", { correlationId: "c2" }),
        event("turn.completed", "agent-2", "2026-11-10T10:00:30Z"),
      ];
      // agent-2's signal is newer but terminated; agent-1's older signal is live.
      expect(reconstructLiveTurn("ws", events)?.agentId).toBe("agent-1");
    });

    it("reconstructs from a production-scale history quickly", () => {
      // Regression test for the 2026-11-10 deploy rollback: the previous
      // O(n^2) rescan spun a full CPU core past the 60s boot health window
      // on the owner workstream (172,971 events, 153,663 signals).
      const events = [];
      const base = Date.parse("2026-10-01T00:00:00Z");
      for (let turn = 0; turn < 3000; turn += 1) {
        const agent = `agent-${turn % 4}`;
        const t0 = new Date(base + turn * 60_000).toISOString();
        events.push(event("run.started", agent, t0, { correlationId: `c${turn}` }));
        for (let delta = 0; delta < 45; delta += 1)
          events.push(event("turn.delta", agent, new Date(base + turn * 60_000 + delta * 1000).toISOString(), { correlationId: `c${turn}`, taskId: `t${turn}` }));
        events.push(event("turn.completed", agent, new Date(base + turn * 60_000 + 50_000).toISOString()));
      }
      // One live zombie turn at the very end, newest signal first in scan order.
      events.push(event("turn.delta", "agent-1", new Date(base + 3000 * 60_000).toISOString(), { correlationId: "zombie", taskId: "tz" }));
      expect(events.length).toBeGreaterThan(140_000);
      const started = Date.now();
      const live = reconstructLiveTurn("ws", events);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(live).toEqual({
        key: "ws:agent-1:zombie",
        agentId: "agent-1",
        taskId: "tz",
        lastSignalAt: Date.parse(new Date(base + 3000 * 60_000).toISOString()),
      });
      // Worst case for the old O(n^2) rescan: every turn completed, so the
      // whole history is scanned and nothing is returned — still fast.
      const completed = events.slice(0, -1);
      const startedAllDone = Date.now();
      expect(reconstructLiveTurn("ws", completed)).toBeUndefined();
      expect(Date.now() - startedAllDone).toBeLessThan(5_000);
    });
  });
});

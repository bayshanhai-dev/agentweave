import { describe, expect, it } from "vitest";
import { projectRuntime } from "../src/runtime-projection.js";

const now = Date.parse("2026-09-04T06:00:00.000Z");

describe("runtime projection", () => {
  it("reports explicit waiting reasons and unavailable usage", () => {
    const projection = projectRuntime(
      {
        status: "active",
        agents: [{ id: "a1", role: "qa", status: "idle" }],
        tasks: [
          { ownerAgentId: "a1", status: "assigned", title: "Review evidence" },
        ],
        events: [],
      },
      now,
    );
    expect(projection.agents[0]).toMatchObject({
      activity: "Waiting to run: Review evidence",
      waitingReason: "Waiting to run: Review evidence",
      providerState: "unavailable",
      usage: { source: "unknown" },
    });
  });

  it("marks a running agent degraded when its provider signal is stale", () => {
    const projection = projectRuntime(
      {
        status: "active",
        agents: [{ id: "a1", role: "coder", status: "running" }],
        tasks: [],
        events: [
          {
            type: "run.heartbeat",
            agentId: "a1",
            message: "coder running",
            elapsedMs: 4_000,
            occurredAt: "2026-09-04T05:59:00.000Z",
          },
        ],
      },
      now,
    );
    expect(projection.headline).toBe("1 agent need attention");
    expect(projection.agents[0]).toMatchObject({
      activity: "Provider signal is stale",
      providerState: "degraded",
      stale: true,
      latencyMs: 4_000,
    });
  });

  it("deduplicates progressive usage updates for one turn", () => {
    const projection = projectRuntime(
      {
        status: "active",
        agents: [{ id: "a1", role: "pm", status: "running" }],
        tasks: [],
        events: [
          {
            type: "usage.updated",
            agentId: "a1",
            correlationId: "turn-1",
            occurredAt: "2026-09-04T05:59:59.500Z",
            usage: { source: "provider", totalTokens: 10 },
          },
          {
            type: "usage.updated",
            agentId: "a1",
            correlationId: "turn-1",
            occurredAt: "2026-09-04T05:59:59.900Z",
            usage: {
              source: "provider",
              inputTokens: 8,
              outputTokens: 7,
              totalTokens: 15,
            },
          },
        ],
      },
      now,
    );
    expect(projection.agents[0]?.usage).toMatchObject({
      source: "provider",
      inputTokens: 8,
      outputTokens: 7,
      totalTokens: 15,
    });
  });
});

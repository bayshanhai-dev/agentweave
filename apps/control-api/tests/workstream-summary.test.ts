import { describe, expect, it } from "vitest";
import { workstreamSummary } from "../src/workstream-summary.js";

describe("workstream list summary", () => {
  it("does not include graph history even when the workstream has many messages", () => {
    const summary = workstreamSummary({
      id: "ws-1",
      goal: "Ship the release",
      flavor: "software-development",
      status: "active",
      provider: {},
      roleProviders: {},
      agents: [{ id: "pm-1", role: "pm", status: "idle" }],
      tasks: Array.from({ length: 100 }, () => ({ status: "done" })),
    });
    expect(summary).not.toHaveProperty("events");
    expect(summary).not.toHaveProperty("messages");
    expect(summary).not.toHaveProperty("tasks");
    expect(JSON.stringify(summary).length).toBeLessThan(2_000);
    expect(summary.taskCounts).toEqual({ done: 100 });
  });
});

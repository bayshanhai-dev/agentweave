import { describe, expect, it } from "vitest";
import { WorkstreamOrchestrator } from "../src/orchestrator.js";

describe("WorkstreamOrchestrator", () => {
  it("routes the workflow through PM, PE, Coder, QA, then Human review", () => {
    const flow = new WorkstreamOrchestrator("ws-1", "process the paper");
    expect(flow.start().recipientRole).toBe("pm");
    expect(flow.apply({ type: "goal.received", content: "process the paper" })?.recipientRole).toBe("pe");
    expect(flow.apply({ type: "task.decomposed", content: "task" })?.recipientRole).toBe("coder");
    expect(flow.apply({ type: "design.completed", content: "design" })?.recipientRole).toBe("qa");
    expect(flow.apply({ type: "qa.passed", content: "pass" })?.recipientRole).toBe("human");
    expect(flow.stage).toBe("waiting_for_human");
    expect(flow.apply({ type: "human.approved", content: "approved" })).toBeUndefined();
    expect(flow.stage).toBe("completed");
  });

  it("routes a QA failure back to Coder and increments the attempt", () => {
    const flow = new WorkstreamOrchestrator("ws-1", "goal");
    flow.start(); flow.apply({ type: "goal.received", content: "goal" }); flow.apply({ type: "task.decomposed", content: "task" }); flow.apply({ type: "design.completed", content: "design" });
    expect(flow.apply({ type: "qa.failed", content: "missing evidence" })?.recipientRole).toBe("coder");
    expect(flow.attempt).toBe(1);
    expect(flow.stage).toBe("coder");
  });

  it("validates intelligent PM orchestration decisions without hardcoding the next role", () => {
    const flow = new WorkstreamOrchestrator("ws-1", "goal");
    expect(flow.validateDecision({ action: "create_task", targetRole: "qa", taskTitle: "Run API integration checks", reason: "The implementation changed materially" }).targetRole).toBe("qa");
    expect(() => flow.validateDecision({ action: "create_task", targetRole: "qa", reason: "missing title" })).toThrow("taskTitle");
    expect(() => flow.validateDecision({ action: "message_agent", targetRole: "coder", reason: "missing content" })).toThrow("content");
  });
});

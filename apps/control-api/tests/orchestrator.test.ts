import { describe, expect, it } from "vitest";
import { extractTaskSpecs, WorkstreamOrchestrator, type OrchestrationPolicy } from "../src/orchestrator.js";

describe("WorkstreamOrchestrator", () => {
  it("routes the software-development policy through its declared responsibilities", () => {
    const flow = new WorkstreamOrchestrator("ws-1", "process the paper");
    expect(flow.start().recipientRole).toBe("pm");
    expect(flow.apply({ type: "goal.received", content: "process the paper" })?.recipientRole).toBe("pe");
    expect(flow.apply({ type: "task.decomposed", content: "task" })?.recipientRole).toBe("backend");
    expect(flow.apply({ type: "design.completed", content: "design" })?.recipientRole).toBe("qa");
    expect(flow.apply({ type: "qa.passed", content: "pass" })?.recipientRole).toBe("pm");
    expect(flow.stage).toBe("lead");
  });

  it("routes a non-SDLC template without naming PM, QA, or Coder", () => {
    const policy: OrchestrationPolicy = { templateId: "research-synthesis", leadRole: "research-lead", planningRole: "researcher", executionRoles: ["synthesizer"], reviewRole: "research-reviewer" };
    const flow = new WorkstreamOrchestrator("research-1", "compare sources", policy);
    expect(flow.start().recipientRole).toBe("research-lead");
    expect(flow.apply({ type: "goal.received", content: "question" })?.recipientRole).toBe("researcher");
    expect(flow.apply({ type: "task.decomposed", content: "evidence" })?.recipientRole).toBe("synthesizer");
    expect(flow.apply({ type: "design.completed", content: "draft" })?.recipientRole).toBe("research-reviewer");
    expect(flow.apply({ type: "qa.passed", content: "reviewed" })?.recipientRole).toBe("research-lead");
  });

  it("routes a review failure back to the template execution role and increments the attempt", () => {
    const flow = new WorkstreamOrchestrator("ws-1", "goal");
    flow.start(); flow.apply({ type: "goal.received", content: "goal" }); flow.apply({ type: "task.decomposed", content: "task" }); flow.apply({ type: "design.completed", content: "design" });
    expect(flow.apply({ type: "qa.failed", content: "missing evidence" })?.recipientRole).toBe("backend");
    expect(flow.attempt).toBe(1);
    expect(flow.stage).toBe("execution");
  });

  it("validates intelligent PM orchestration decisions without hardcoding the next role", () => {
    const flow = new WorkstreamOrchestrator("ws-1", "goal");
    expect(flow.validateDecision({ action: "create_task", targetRole: "qa", taskTitle: "Run API integration checks", reason: "The implementation changed materially" }).targetRole).toBe("qa");
    expect(() => flow.validateDecision({ action: "create_task", targetRole: "qa", reason: "missing title" })).toThrow("taskTitle");
    expect(() => flow.validateDecision({ action: "message_agent", targetRole: "coder", reason: "missing content" })).toThrow("content");
  });

  it("extracts multiple independent owned tasks from PM output", () => {
    expect(extractTaskSpecs("[TASKS]\n1. [PE] Define the document model\n2. [CODER] Implement the parser\n3. [QA] Add regression coverage")).toEqual([
      { title: "Define the document model", ownerRole: "pe" },
      { title: "Implement the parser", ownerRole: "coder" },
      { title: "Add regression coverage", ownerRole: "qa" },
    ]);
  });
});

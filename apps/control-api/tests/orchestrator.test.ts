import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { extractTaskSpecs, WorkstreamOrchestrator } from "../src/orchestrator.js";

type TraceStep = {
  operation?: "start";
  event?: Parameters<WorkstreamOrchestrator["apply"]>[0]["type"];
  content?: string;
  expectedRecipient: string;
  expectedStage: string;
};

const mockTrace = JSON.parse(
  readFileSync(new URL("./fixtures/mock-workflow-trace.json", import.meta.url), "utf8"),
) as { goal: string; steps: TraceStep[] };

describe("WorkstreamOrchestrator", () => {
  it("routes the workflow through PM, PE, Coder, QA, then returns to PM for completion triage", () => {
    const flow = new WorkstreamOrchestrator("ws-1", "process the paper");
    expect(flow.start().recipientRole).toBe("pm");
    expect(flow.apply({ type: "goal.received", content: "process the paper" })?.recipientRole).toBe("pe");
    expect(flow.apply({ type: "task.decomposed", content: "task" })?.recipientRole).toBe("coder");
    expect(flow.apply({ type: "design.completed", content: "design" })?.recipientRole).toBe("qa");
    expect(flow.apply({ type: "qa.passed", content: "pass" })?.recipientRole).toBe("pm");
    expect(flow.stage).toBe("pm");
  });

  it("preserves the machine-readable Mock demo trace", () => {
    const flow = new WorkstreamOrchestrator("mock-trace", mockTrace.goal);
    for (const step of mockTrace.steps) {
      const action = step.operation === "start"
        ? flow.start()
        : flow.apply({ type: step.event!, content: step.content ?? "" });
      expect(action?.recipientRole).toBe(step.expectedRecipient);
      expect(flow.stage).toBe(step.expectedStage);
    }
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

  it("extracts multiple independent owned tasks from PM output", () => {
    expect(extractTaskSpecs("[TASKS]\n1. [PE] Define the document model\n2. [CODER] Implement the parser\n3. [QA] Add regression coverage")).toEqual([
      { title: "Define the document model", ownerRole: "pe" },
      { title: "Implement the parser", ownerRole: "coder" },
      { title: "Add regression coverage", ownerRole: "qa" },
    ]);
  });
});

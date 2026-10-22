import { describe, expect, it } from "vitest";
import { completedTaskIdsForPhaseResult, deriveHandoffTitle, extractTaskSpecs, reviewedTaskFor, selectPlannedTask, sliceFromDecompositionMarker, taskWasDispatchedToAgent, WorkstreamOrchestrator, type OrchestrationPolicy } from "../src/orchestrator.js";

describe("sliceFromDecompositionMarker", () => {
  it("slices from a marker at the start of the reply", () => {
    expect(sliceFromDecompositionMarker("[READY_FOR_DECOMPOSITION] - [backend] Build API")).toBe(
      "[READY_FOR_DECOMPOSITION]\n - [backend] Build API",
    );
  });

  it("slices from the last marker at a later line start", () => {
    expect(sliceFromDecompositionMarker("preface\n[READY_FOR_DECOMPOSITION]\n- [backend] First\n[READY_FOR_DECOMPOSITION]\n- [qa] Test"))
      .toBe("[READY_FOR_DECOMPOSITION]\n\n- [qa] Test");
  });

  it("does not slice an inline marker in echoed instruction text", () => {
    const text = "Begin your reply with [READY_FOR_DECOMPOSITION], then one line per task";
    expect(sliceFromDecompositionMarker(text)).toBe(text);
  });

  it("returns text without a marker unchanged", () => {
    expect(sliceFromDecompositionMarker("No decomposition marker here")).toBe("No decomposition marker here");
  });
});

describe("WorkstreamOrchestrator", () => {
  it("routes the software-development policy through its declared responsibilities", () => {
    const flow = new WorkstreamOrchestrator("ws-1", "process the paper");
    const leadAction = flow.start();
    expect(leadAction.recipientRole).toBe("pm");
    expect(leadAction.content).toContain("[PROPOSE_COMPLETE]");
    expect(leadAction.content).toContain("[HUMAN_BLOCKED]");
    expect(flow.apply({ type: "goal.received", content: "process the paper" })?.recipientRole).toBe("pe");
    expect(flow.apply({ type: "task.decomposed", content: "task" })?.recipientRole).toBe("backend");
    const reviewAction = flow.apply({ type: "design.completed", content: "design" });
    expect(reviewAction?.recipientRole).toBe("qa");
    expect(reviewAction?.content).toContain("[QA_PASSED]");
    expect(reviewAction?.content).toContain("[QA_FAILED]");
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

  it("parks for Human review when another review outcome would exceed the round limit", () => {
    const previous = process.env.AGENTWEAVE_MAX_ORCHESTRATION_ROUNDS;
    process.env.AGENTWEAVE_MAX_ORCHESTRATION_ROUNDS = "1";
    try {
      const flow = new WorkstreamOrchestrator("ws-1", "goal");
      flow.start(); flow.apply({ type: "goal.received", content: "goal" }); flow.apply({ type: "task.decomposed", content: "task" }); flow.apply({ type: "implementation.completed", content: "implementation" });
      expect(flow.apply({ type: "qa.passed", content: "pass" })?.recipientRole).toBe("pm");
      flow.apply({ type: "goal.received", content: "more work" }); flow.apply({ type: "task.decomposed", content: "task" }); flow.apply({ type: "implementation.completed", content: "implementation" });

      const action = flow.apply({ type: "qa.passed", content: "pass again" });

      expect(action?.recipientRole).toBe("human");
      expect(action?.content).toContain("round limit of 1 was reached without convergence");
      expect(flow.stage).toBe("waiting_for_human");
    } finally {
      if (previous === undefined) delete process.env.AGENTWEAVE_MAX_ORCHESTRATION_ROUNDS;
      else process.env.AGENTWEAVE_MAX_ORCHESTRATION_ROUNDS = previous;
    }
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

  it("rejects the protocol placeholder example", () => {
    expect(extractTaskSpecs("- [role] Task title")).toEqual([]);
  });

  it("rejects the placeholder title with a real role", () => {
    expect(extractTaskSpecs("- [backend] Task title")).toEqual([]);
  });

  it("continues to parse a normal task", () => {
    expect(extractTaskSpecs("- [frontend] Build the dashboard")).toEqual([
      { title: "Build the dashboard", ownerRole: "frontend" },
    ]);
  });

  it("keeps only real tasks when placeholders and real tasks are mixed", () => {
    expect(extractTaskSpecs("- [role] Task title\n- [backend] Implement the API\n- [frontend] Task title")).toEqual([
      { title: "Implement the API", ownerRole: "backend" },
    ]);
  });

  it("selects lead-created tasks, prefers the recipient's owner role, and reuses the last task for a fix-up", () => {
    const tasks = [
      { id: "pe-pseudo", status: "assigned", ownerAgentId: "frontend-agent", createdByAgentId: "pe" },
      { id: "backend-pseudo", status: "ready", ownerAgentId: "backend-agent", createdByAgentId: "backend" },
      { id: "qa-pseudo", status: "assigned", ownerAgentId: "frontend-agent", createdByAgentId: "qa" },
      { id: "done", status: "done", ownerAgentId: "frontend-agent", createdByAgentId: "lead" },
      { id: "backend-first", status: "assigned", ownerAgentId: "backend-agent", createdByAgentId: "lead" },
      { id: "frontend-match", status: "ready", ownerAgentId: "frontend-agent", createdByAgentId: "lead" },
    ];

    expect(selectPlannedTask(tasks, "lead", { fixUp: false, recipientAgentId: "frontend-agent" })?.id).toBe("frontend-match");
    expect(selectPlannedTask(tasks, "lead", { fixUp: false, recipientAgentId: "devops-agent" })?.id).toBe("backend-first");
    expect(selectPlannedTask(tasks, "lead", { fixUp: true, recipientAgentId: "backend-agent", lastExecutedTaskId: "done" })?.id).toBe("done");
  });

  it("settles a dispatched execution and review before selecting the next planned task", () => {
    const tasks = [
      { id: "implementation-1", status: "running", ownerAgentId: "frontend-agent", createdByAgentId: "lead", relatedTaskIds: [] },
      { id: "implementation-2", status: "assigned", ownerAgentId: "backend-agent", createdByAgentId: "lead", relatedTaskIds: [] },
      { id: "review-1", status: "running", ownerAgentId: "qa-agent", createdByAgentId: "backend-agent", parentTaskId: "implementation-1", relatedTaskIds: ["implementation-1"] },
    ];
    const messages = [
      { taskId: "implementation-1", recipientIds: ["backend-agent"], correlationId: "execution-handoff" },
      { taskId: "review-1", recipientIds: ["qa-agent"], correlationId: "review-handoff" },
    ];

    // The selected task was historically sent to the default backend even
    // though it was owned by frontend. The exact dispatch still authorizes
    // the result and prevents the parent from remaining "running".
    expect(taskWasDispatchedToAgent(messages, "implementation-1", "backend-agent", "execution-handoff")).toBe(true);
    for (const id of completedTaskIdsForPhaseResult(tasks, messages, {
      taskId: "implementation-1", agentId: "backend-agent", correlationId: "execution-handoff", reviewPassed: false,
    })) tasks.find((task) => task.id === id)!.status = "done";
    expect(taskWasDispatchedToAgent(messages, "review-1", "qa-agent", "review-handoff")).toBe(true);
    expect(reviewedTaskFor(tasks, tasks[2]!)?.id).toBe("implementation-1");
    for (const id of completedTaskIdsForPhaseResult(tasks, messages, {
      taskId: "review-1", agentId: "qa-agent", correlationId: "review-handoff", reviewPassed: true,
    })) tasks.find((task) => task.id === id)!.status = "done";

    const next = selectPlannedTask(tasks, "lead", {
      fixUp: false,
      dispatchedTaskIds: new Set(["implementation-1"]),
    });

    expect(next?.id).toBe("implementation-2");
    expect(next?.id).not.toBe("implementation-1");
    expect(tasks[0]!.status).toBe("done");
    expect(tasks[2]!.status).toBe("done");
  });

  it("does not reissue an already-dispatched phase whose status was not settled", () => {
    const tasks = [
      { id: "implementation-1", status: "running", ownerAgentId: "backend-agent", createdByAgentId: "lead" },
      { id: "implementation-2", status: "assigned", ownerAgentId: "frontend-agent", createdByAgentId: "lead" },
    ];

    expect(selectPlannedTask(tasks, "lead", {
      fixUp: false,
      dispatchedTaskIds: new Set(["implementation-1"]),
    })?.id).toBe("implementation-2");
  });

  it("never derives a task title from an agentweave marker", () => {
    const title = deriveHandoffTitle("[agentweave template=software-development phase=review]\nReview this", "Review the implementation");
    expect(title).toBe("Review the implementation");
    expect(title.toLowerCase().startsWith("[agentweave")).toBe(false);
  });
});

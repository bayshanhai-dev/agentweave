export type OrchestratorStage = "pm" | "pe" | "coder" | "qa" | "waiting_for_human" | "completed";
export type OrchestratorEvent = { type: "goal.received" | "task.decomposed" | "design.completed" | "implementation.completed" | "qa.passed" | "qa.failed" | "human.approved" | "human.rejected" | "human.clarification.replied"; content: string; evidenceIds?: string[] };
export type OrchestratorAction = { stage: Exclude<OrchestratorStage, "completed">; recipientRole: "pm" | "pe" | "coder" | "qa" | "human"; messageType: "request" | "decision"; content: string; attempt: number };
export type OrchestrationDecision = {
  action: "create_task" | "message_agent" | "wait" | "ask_human" | "complete";
  targetRole?: "pm" | "pe" | "coder" | "qa" | "human";
  content?: string;
  taskTitle?: string;
  reason: string;
};

export class WorkstreamOrchestrator {
  stage: OrchestratorStage = "pm";
  attempt = 0;
  constructor(readonly workstreamId: string, readonly goal: string) {}

  requiresClarification(): boolean {
    const goal = this.goal.trim();
    const vague = /\b(improve|production[- ]ready|make better|enhance|optimi[sz]e|work on)\b/i.test(goal);
    const concrete = /\b(acceptance|criteria|must|should|test|deliver|release|scope|feature|bug|performance|security|endpoint|screen|report)\b/i.test(goal);
    return goal.length < 80 || (vague && !concrete);
  }

  clarificationQuestions(): string {
    return "Before I decompose this Workstream, please clarify:\n1. Which specific area or outcome should we improve first?\n2. What priority or constraints should guide the work?\n3. What acceptance criteria define production-ready for this Workstream?";
  }

  /**
   * The PM Lead is the intelligent workflow orchestrator. This class remains
   * the deterministic safety layer: it validates the decision and exposes a
   * normalized action for the Control API to execute.
   */
  validateDecision(decision: OrchestrationDecision): OrchestrationDecision {
    if (!decision.reason.trim()) throw new Error("Orchestration decisions require a reason");
    if ((decision.action === "create_task" || decision.action === "message_agent" || decision.action === "ask_human") && !decision.targetRole) {
      throw new Error(`${decision.action} requires a targetRole`);
    }
    if (decision.action === "create_task" && !decision.taskTitle?.trim()) throw new Error("create_task requires taskTitle");
    if (decision.action === "message_agent" && !decision.content?.trim()) throw new Error("message_agent requires content");
    return decision;
  }

  start(): OrchestratorAction { if (this.stage !== "pm") throw new Error(`Cannot start from ${this.stage}`); return { stage: "pm", recipientRole: "pm", messageType: "request", content: `PM clarification gate. Do not inspect the workspace, call tools, edit files, decompose tasks, or perform implementation work in this turn. First decide whether the goal contains an explicit target scope and acceptance criteria. If either is missing, unclear, or open to multiple interpretations, this turn MUST be a Human follow-up: reply immediately with one message beginning exactly with [CLARIFICATION_REQUEST] and then the minimum concrete questions. Do not produce a plan in that case. Only when the target and acceptance criteria are explicit may you reply with [READY_FOR_DECOMPOSITION] followed by a concise decomposition.\n\nWorkstream goal:\n${this.goal}`, attempt: this.attempt }; }

  apply(event: OrchestratorEvent): OrchestratorAction | undefined {
    if (event.type === "goal.received" && this.stage === "pm") { this.stage = "pe"; return this.action("pe", "PM decomposition:\n" + event.content); }
    if (event.type === "task.decomposed" && this.stage === "pe") { this.stage = "coder"; return this.action("coder", "Implementation task and acceptance criteria:\n" + event.content); }
    if (event.type === "design.completed" && this.stage === "coder") { this.stage = "qa"; return this.action("qa", "Review implementation, tests, and evidence:\n" + event.content, event.evidenceIds); }
    if (event.type === "implementation.completed" && this.stage === "qa") { return this.action("qa", "Review implementation, tests, and evidence:\n" + event.content, event.evidenceIds); }
    if (event.type === "qa.failed" && this.stage === "qa") { this.attempt += 1; this.stage = "coder"; return this.action("coder", "QA retry required:\n" + event.content, event.evidenceIds); }
    if (event.type === "qa.passed" && this.stage === "qa") { this.stage = "waiting_for_human"; return this.action("human", "QA passed. Human review is required before completion."); }
    if (event.type === "human.approved" && this.stage === "waiting_for_human") { this.stage = "completed"; return undefined; }
    if (event.type === "human.rejected" && this.stage === "waiting_for_human") { this.attempt += 1; this.stage = "pm"; return this.action("pm", "Human requested another review:\n" + event.content); }
    if (event.type === "human.clarification.replied" && this.stage === "waiting_for_human") { this.stage = "pm"; return this.action("pm", "Human clarification received:\n" + event.content); }
    throw new Error(`Invalid orchestrator event ${event.type} at ${this.stage}`);
  }

  private action(recipientRole: OrchestratorAction["recipientRole"], content: string, evidenceIds?: string[]): OrchestratorAction {
    return { stage: this.stage, recipientRole, messageType: recipientRole === "human" ? "decision" : "request", content, attempt: this.attempt, ...(evidenceIds?.length ? { evidenceIds } : {}) } as OrchestratorAction;
  }
}

export type OrchestratorStage = "pm" | "pe" | "coder" | "qa" | "waiting_for_human" | "completed";
export type OrchestratorEvent = { type: "goal.received" | "task.decomposed" | "design.completed" | "implementation.completed" | "qa.passed" | "qa.failed" | "human.approved" | "human.rejected"; content: string; evidenceIds?: string[] };
export type OrchestratorAction = { stage: Exclude<OrchestratorStage, "completed">; recipientRole: "pm" | "pe" | "coder" | "qa" | "human"; messageType: "request" | "decision"; content: string; attempt: number };

export class WorkstreamOrchestrator {
  stage: OrchestratorStage = "pm";
  attempt = 0;
  constructor(readonly workstreamId: string, readonly goal: string) {}

  start(): OrchestratorAction { if (this.stage !== "pm") throw new Error(`Cannot start from ${this.stage}`); return { stage: "pm", recipientRole: "pm", messageType: "request", content: this.goal, attempt: this.attempt }; }

  apply(event: OrchestratorEvent): OrchestratorAction | undefined {
    if (event.type === "goal.received" && this.stage === "pm") { this.stage = "pe"; return this.action("pe", "PM decomposition:\n" + event.content); }
    if (event.type === "task.decomposed" && this.stage === "pe") { this.stage = "coder"; return this.action("coder", "Implementation task and acceptance criteria:\n" + event.content); }
    if (event.type === "design.completed" && this.stage === "coder") { this.stage = "qa"; return this.action("qa", "Review implementation, tests, and evidence:\n" + event.content, event.evidenceIds); }
    if (event.type === "implementation.completed" && this.stage === "qa") { return this.action("qa", "Review implementation, tests, and evidence:\n" + event.content, event.evidenceIds); }
    if (event.type === "qa.failed" && this.stage === "qa") { this.attempt += 1; this.stage = "coder"; return this.action("coder", "QA retry required:\n" + event.content, event.evidenceIds); }
    if (event.type === "qa.passed" && this.stage === "qa") { this.stage = "waiting_for_human"; return this.action("human", "QA passed. Human review is required before completion."); }
    if (event.type === "human.approved" && this.stage === "waiting_for_human") { this.stage = "completed"; return undefined; }
    if (event.type === "human.rejected" && this.stage === "waiting_for_human") { this.attempt += 1; this.stage = "pm"; return this.action("pm", "Human requested another review:\n" + event.content); }
    throw new Error(`Invalid orchestrator event ${event.type} at ${this.stage}`);
  }

  private action(recipientRole: OrchestratorAction["recipientRole"], content: string, evidenceIds?: string[]): OrchestratorAction {
    return { stage: this.stage, recipientRole, messageType: recipientRole === "human" ? "decision" : "request", content, attempt: this.attempt, ...(evidenceIds?.length ? { evidenceIds } : {}) } as OrchestratorAction;
  }
}

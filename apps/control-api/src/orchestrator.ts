export type OrchestratorStage = "pm" | "pe" | "coder" | "qa" | "waiting_for_human" | "completed";
export type OrchestratorEvent = { type: "goal.received" | "task.decomposed" | "design.completed" | "implementation.completed" | "qa.passed" | "qa.failed" | "human.approved" | "human.rejected" | "human.clarification.replied"; content: string; evidenceIds?: string[] };
export type TaskSpec = { title: string; ownerRole?: "pm" | "pe" | "coder" | "backend" | "frontend" | "qa" | "devops"; acceptanceCriteria?: string[]; dependencies?: string[]; parentTaskId?: string; relatedTaskIds?: string[] };
export type OrchestratorAction = { stage: Exclude<OrchestratorStage, "completed">; recipientRole: "pm" | "pe" | "coder" | "qa" | "human"; messageType: "request" | "decision"; content: string; attempt: number; taskSpecs?: TaskSpec[] };
export type OrchestrationDecision = {
  action: "create_task" | "message_agent" | "wait" | "ask_human" | "complete";
  targetRole?: "pm" | "pe" | "coder" | "qa" | "human";
  content?: string;
  taskTitle?: string;
  tasks?: TaskSpec[];
  reason: string;
};

export class WorkstreamOrchestrator {
  stage: OrchestratorStage = "pm";
  attempt = 0;
  constructor(readonly workstreamId: string, readonly goal: string) {}

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
    if (decision.action === "create_task" && !decision.taskTitle?.trim() && !decision.tasks?.length) throw new Error("create_task requires taskTitle or tasks");
    if (decision.action === "message_agent" && !decision.content?.trim()) throw new Error("message_agent requires content");
    return decision;
  }

  start(): OrchestratorAction { if (this.stage !== "pm") throw new Error(`Cannot start from ${this.stage}`); return { stage: "pm", recipientRole: "pm", messageType: "request", content: `You are the PM and intelligent orchestrator for this Workstream. Analyze the goal, decide the next useful action, and coordinate with the Agent Hive. Work autonomously: do not ask Human for routine ambiguity, preferences, confirmation, or missing detail. Make the best-supported assumptions, consult other Agents, and continue the work. Only when progress is genuinely impossible without a Human decision may you begin exactly with [HUMAN_BLOCKED] and state the single decision needed. When decomposing work, produce multiple independent actionable tasks when useful using a numbered or bulleted list; prefix each owner with [PE], [CODER], or [QA]. Do not invent work that is unrelated to the goal. When the Workstream is genuinely ready for Human completion review, begin your response exactly with [PROPOSE_COMPLETE] and state the evidence; otherwise keep the Hive collaborating.\n\nWorkstream goal:\n${this.goal}`, attempt: this.attempt }; }

  apply(event: OrchestratorEvent): OrchestratorAction | undefined {
    if (event.type === "goal.received" && this.stage === "pm") { this.stage = "pe"; return this.action("pe", "PM decomposition:\n" + event.content); }
    if (event.type === "task.decomposed" && this.stage === "pe") { this.stage = "coder"; return this.action("coder", "Implementation task and acceptance criteria:\n" + event.content); }
    if (event.type === "design.completed" && this.stage === "coder") { this.stage = "qa"; return this.action("qa", "Review implementation, tests, and evidence:\n" + event.content, event.evidenceIds); }
    if (event.type === "implementation.completed" && this.stage === "qa") { return this.action("qa", "Review implementation, tests, and evidence:\n" + event.content, event.evidenceIds); }
    if (event.type === "qa.failed" && this.stage === "qa") { this.attempt += 1; this.stage = "coder"; return this.action("coder", "QA retry required:\n" + event.content, event.evidenceIds); }
    if (event.type === "qa.passed" && this.stage === "qa") { this.stage = "pm"; return this.action("pm", `QA review completed successfully:\n${event.content}\n\nReview this outcome and decide the next useful action. Continue collaboration if there is any meaningful work, review, deployment, or follow-up remaining. Only if the Workstream is genuinely ready for Human completion review, begin your response exactly with [PROPOSE_COMPLETE] followed by a concise evidence-backed summary.`); }
    if (event.type === "human.approved" && this.stage === "waiting_for_human") { this.stage = "completed"; return undefined; }
    if (event.type === "human.rejected" && this.stage === "waiting_for_human") { this.attempt += 1; this.stage = "pm"; return this.action("pm", "Human requested another review:\n" + event.content); }
    if (event.type === "human.clarification.replied" && this.stage === "waiting_for_human") { this.stage = "pm"; return this.action("pm", "Human clarification received:\n" + event.content); }
    throw new Error(`Invalid orchestrator event ${event.type} at ${this.stage}`);
  }

  private action(recipientRole: OrchestratorAction["recipientRole"], content: string, evidenceIds?: string[]): OrchestratorAction {
    return { stage: this.stage, recipientRole, messageType: recipientRole === "human" ? "decision" : "request", content, attempt: this.attempt, ...(evidenceIds?.length ? { evidenceIds } : {}) } as OrchestratorAction;
  }
}

/** Extracts the deliberately small, human-readable task format from PM output. */
export function extractTaskSpecs(text: string): TaskSpec[] {
  const specs: TaskSpec[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(/^(?:[-*]|\d+[.)])\s+(?:\[(PM|PE|CODER|QA)\]\s*)?(.+)$/i);
    if (!match) continue;
    const title = match[2]!.replace(/\s+—\s+.*$/, "").replace(/\s+-\s+acceptance:.*$/i, "").trim();
    if (title.length < 4 || title.length > 240) continue;
    const ownerRole = match[1]?.toLowerCase() as TaskSpec["ownerRole"] | undefined;
    specs.push({ title, ...(ownerRole ? { ownerRole } : {}) });
    if (specs.length === 12) break;
  }
  return specs;
}

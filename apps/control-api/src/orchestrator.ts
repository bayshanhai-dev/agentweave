export type OrchestratorStage = "lead" | "planning" | "execution" | "review" | "waiting_for_human" | "completed";
export type OrchestratorEvent = { type: "goal.received" | "task.decomposed" | "design.completed" | "implementation.completed" | "qa.passed" | "qa.failed" | "human.approved" | "human.rejected" | "human.clarification.replied"; content: string; evidenceIds?: string[] };
export type TaskSpec = { title: string; ownerRole?: string; acceptanceCriteria?: string[]; dependencies?: string[]; parentTaskId?: string; relatedTaskIds?: string[] };
export type OrchestrationPolicy = { templateId: string; leadRole: string; planningRole: string; executionRoles: readonly string[]; reviewRole: string };
export type OrchestratorAction = { stage: Exclude<OrchestratorStage, "completed">; recipientRole: string | "human"; messageType: "request" | "decision"; content: string; attempt: number; taskSpecs?: TaskSpec[] };
export type OrchestrationDecision = {
  action: "create_task" | "message_agent" | "wait" | "ask_human" | "complete";
  targetRole?: string | "human";
  content?: string;
  taskTitle?: string;
  tasks?: TaskSpec[];
  reason: string;
};

export const softwareDevelopmentPolicy: OrchestrationPolicy = {
  templateId: "software-development", leadRole: "pm", planningRole: "pe", executionRoles: ["backend", "frontend"], reviewRole: "qa",
};

export class WorkstreamOrchestrator {
  stage: OrchestratorStage = "lead";
  attempt = 0;
  /** Counts review outcomes that restarted orchestration; the next outcome beyond the configured limit parks the Workstream. */
  round = 0;
  readonly maxRounds: number;
  readonly executionRole: string;
  constructor(readonly workstreamId: string, readonly goal: string, readonly policy: OrchestrationPolicy = softwareDevelopmentPolicy) {
    this.executionRole = policy.executionRoles[0] ?? policy.planningRole;
    const configuredMaxRounds = Number.parseInt(process.env.AGENTWEAVE_MAX_ORCHESTRATION_ROUNDS ?? "6", 10);
    this.maxRounds = Number.isFinite(configuredMaxRounds) && configuredMaxRounds >= 0 ? configuredMaxRounds : 6;
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
    if (decision.action === "create_task" && !decision.taskTitle?.trim() && !decision.tasks?.length) throw new Error("create_task requires taskTitle or tasks");
    if (decision.action === "message_agent" && !decision.content?.trim()) throw new Error("message_agent requires content");
    return decision;
  }

  start(): OrchestratorAction {
    if (this.stage !== "lead") throw new Error(`Cannot start from ${this.stage}`);
    return this.action(this.policy.leadRole, "lead", `Analyze the Workstream goal, coordinate the available roles, and only request Human input when progress is genuinely blocked.\n\nWorkstream goal:\n${this.goal}`);
  }

  apply(event: OrchestratorEvent): OrchestratorAction | undefined {
    if (event.type === "goal.received" && this.stage === "lead") { this.stage = "planning"; return this.action(this.policy.planningRole, "planning", event.content); }
    if (event.type === "task.decomposed" && this.stage === "planning") { this.stage = "execution"; return this.action(this.executionRole, "execution", event.content); }
    if ((event.type === "design.completed" || event.type === "implementation.completed") && this.stage === "execution") { this.stage = "review"; return this.action(this.policy.reviewRole, "review", event.content, event.evidenceIds); }
    if ((event.type === "qa.failed" || event.type === "qa.passed") && this.stage === "review") {
      if (this.round >= this.maxRounds) {
        this.stage = "waiting_for_human";
        return this.action("human", "lead", `The orchestration round limit of ${this.maxRounds} was reached without convergence. Human review is required before more agent work is dispatched.`);
      }
      this.round += 1;
      if (event.type === "qa.failed") { this.attempt += 1; this.stage = "execution"; return this.action(this.executionRole, "execution", event.content, event.evidenceIds); }
      this.stage = "lead"; return this.action(this.policy.leadRole, "lead", event.content);
    }
    if (event.type === "human.approved" && this.stage === "waiting_for_human") { this.stage = "completed"; return undefined; }
    if (event.type === "human.rejected" && this.stage === "waiting_for_human") { this.attempt += 1; this.stage = "lead"; return this.action(this.policy.leadRole, "lead", event.content); }
    if (event.type === "human.clarification.replied" && this.stage === "waiting_for_human") { this.stage = "lead"; return this.action(this.policy.leadRole, "lead", event.content); }
    throw new Error(`Invalid orchestrator event ${event.type} at ${this.stage}`);
  }

  private action(recipientRole: string | "human", phase: Exclude<OrchestratorStage, "waiting_for_human" | "completed">, body: string, evidenceIds?: string[]): OrchestratorAction {
    const marker = `[agentweave template=${this.policy.templateId} phase=${phase} recipient=${recipientRole} lead=${this.policy.leadRole} planning=${this.policy.planningRole} execution=${this.executionRole} review=${this.policy.reviewRole}]`;
    const protocol = recipientRole === "human" ? "" : phase === "lead"
      ? "\n\nCompletion protocol:\nWhen the Workstream goal is achieved and review has passed, your reply MUST begin with [PROPOSE_COMPLETE] followed by a short evidence summary.\nIf progress is genuinely blocked on human input, your reply MUST begin with [HUMAN_BLOCKED] followed by the question. Otherwise, reply with the next tasks as a bullet list."
      : phase === "review"
        ? "\n\nReview protocol:\nYour reply MUST begin with [QA_PASSED] when the implementation satisfies the goal and acceptance criteria, or [QA_FAILED] followed by the concrete failures otherwise."
        : "";
    return { stage: this.stage as Exclude<OrchestratorStage, "completed">, recipientRole, messageType: recipientRole === "human" ? "decision" : "request", content: `${marker}\n${body}${protocol}`, attempt: this.attempt, ...(evidenceIds?.length ? { evidenceIds } : {}) };
  }
}

/** Extracts the deliberately small, human-readable task format from PM output. */
export function extractTaskSpecs(text: string): TaskSpec[] {
  const specs: TaskSpec[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(/^(?:[-*]|\d+[.)])\s+(?:\[([a-z][a-z0-9_-]*)\]\s*)?(.+)$/i);
    if (!match) continue;
    const title = match[2]!.replace(/\s+—\s+.*$/, "").replace(/\s+-\s+acceptance:.*$/i, "").trim();
    if (title.length < 4 || title.length > 240) continue;
    const ownerRole = match[1]?.toLowerCase();
    specs.push({ title, ...(ownerRole ? { ownerRole } : {}) });
    if (specs.length === 12) break;
  }
  return specs;
}

import { providerError } from "./errors.js";
import { agentTurnResultSchema } from "@agentweave/protocol";
import type { ProviderAdapter, ProviderCapabilities, ProviderRunEvent, ProviderRunInput, ProviderRunResult, ProviderSession, SessionCheckpoint } from "./types.js";

export class MockProviderAdapter implements ProviderAdapter {
  readonly name = "mock";
  readonly capabilities: ProviderCapabilities = { streaming: true, toolCalls: true, resume: true, cancellation: true };
  private readonly completed = new Map<string, ProviderRunResult>();
  private readonly multiturnCounts = new Map<string, number>();
  constructor(private readonly options: { delayMs?: number; fail?: boolean; qa?: "pass" | "fail" } = {}) {}
  async createSession(input: { model?: string } = {}): Promise<ProviderSession> { const now = new Date().toISOString(); return { provider: this.name, ...(input.model ? { model: input.model } : {}), providerSessionId: `mock-${crypto.randomUUID()}`, status: "active", createdAt: now, updatedAt: now }; }
  async resumeSession(session: ProviderSession): Promise<ProviderSession> { return { ...session, status: "active", updatedAt: new Date().toISOString() }; }
  async checkpoint(session: ProviderSession): Promise<SessionCheckpoint> { return { provider: session.provider, providerSessionId: session.providerSessionId, ...(session.providerTurnId ? { providerTurnId: session.providerTurnId } : {}), sequence: 0, state: { deterministic: true }, createdAt: new Date().toISOString() }; }
  async *run(input: ProviderRunInput): AsyncGenerator<ProviderRunEvent, ProviderRunResult> {
    const session = input.session ?? await this.createSession(input.model ? { model: input.model } : {}); const turnId = `${session.providerSessionId}:turn:${input.idempotencyKey ?? input.input.length}`;
    const prior = this.completed.get(turnId); if (prior) { yield { type: "turn.completed", turnId, text: prior.text }; return prior; }
    yield { type: "turn.started", turnId, ...(input.correlationId ? { correlationId: input.correlationId } : {}) };
    if (this.options.delayMs) await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    if (this.options.fail) { const error = providerError("Mock provider failure", "provider", "retryable", { code: "MOCK_FAILURE" }); yield { type: "turn.failed", turnId, error }; throw new Error(error.message); }
    const multiturn =
      input.input.startsWith("[agentweave multiturn=twoturn]") ||
      (this.multiturnCounts.get(session.providerSessionId) ?? 0) > 0;
    const multiturnTurn = multiturn ? this.nextMultiturnTurn(session) : 0;
    const collaboration = parseCollaborationScenario(input.input);
    const scenario = parseScenario(input.input);
    const text = multiturn ? `Mock multiturn turn ${multiturnTurn} of 2 completed` : collaboration ? `Mock ${collaboration.stage} insight completed` : this.options.qa === "fail" && scenario?.phase === "review" ? "Mock review failed" : scenario ? `Mock ${scenario.phase} completed for ${scenario.template}` : demoResponse(input.input);
    yield { type: "turn.delta", turnId, text }; yield { type: "turn.completed", turnId, text };
    const structuredResult = agentTurnResultSchema.parse(multiturn ? multiturnResult(multiturnTurn, text) : collaboration ? collaborationResult(collaboration, input.input, text) : scenario ? scenarioResult(scenario, text, this.options.qa) : input.input.includes("You are the PM and intelligent orchestrator") && this.options.qa !== "fail" ? {
      summary: text,
      insights: [{ id: "editor-model", content: "Keep the markdown document model separate from preview rendering so accessibility and formatting can be reviewed independently." }],
      tasks: [{ id: "design", title: "Define the markdown note document model and accessibility requirements", ownerRole: "pe", acceptanceCriteria: ["Document model and accessibility requirements are explicit"] }],
      messages: [{ recipientRole: "pe", messageType: "request", taskId: "design", content: "PM decomposition: Define the markdown document model and accessibility requirements; keep document state separate from preview rendering." }],
    } : demoStructuredResult(input.input, text, this.options.qa));
    const result: ProviderRunResult = { turnId, text, structuredResult, session: { ...session, providerTurnId: turnId, status: "completed" as const, updatedAt: new Date().toISOString() } }; this.completed.set(turnId, result); return result;
  }
  async *cancel(_session: ProviderSession, turnId: string, correlationId?: string): AsyncGenerator<ProviderRunEvent> { yield { type: "turn.cancelled", turnId, ...(correlationId ? { correlationId } : {}) }; }

  /** Deterministic two-turn scenario: turn 1 asks to continue, turn 2 proposes completion. Counted per provider session. */
  private nextMultiturnTurn(session: ProviderSession): number {
    const turn = (this.multiturnCounts.get(session.providerSessionId) ?? 0) + 1;
    this.multiturnCounts.set(session.providerSessionId, turn);
    return turn;
  }
}

type Scenario = { template: string; phase: "lead" | "planning" | "execution" | "review" | "complete"; recipient: string; lead: string; planning: string; execution: string; review: string };
type CollaborationScenario = { roundId: string; stage: "proposal" | "critique" | "synthesis"; key: string };

function multiturnResult(turn: number, summary: string) {
  if (turn < 2) return { summary, decision: { action: "continue" as const, reason: "First turn gathered the context; a second turn is needed to finish." } };
  return { summary, completionProposal: { reason: "Two-turn scenario completed with a verified result." } };
}

function parseCollaborationScenario(prompt: string): CollaborationScenario | undefined {
  const match = prompt.match(/^\[agentweave collaboration=([^\s]+) stage=(proposal|critique|synthesis) key=([^\]]+)\]/);
  if (!match) return undefined;
  return { roundId: decodeURIComponent(match[1]!), stage: match[2] as CollaborationScenario["stage"], key: decodeURIComponent(match[3]!) };
}

function collaborationResult(scenario: CollaborationScenario, prompt: string, summary: string) {
  const referencesMatch = prompt.match(/references (\[[^\n]+\])/);
  const references = referencesMatch ? JSON.parse(referencesMatch[1]!) as string[] : [];
  if (scenario.stage === "proposal") return { summary, insights: [{ id: scenario.key, kind: "proposal" as const, content: `${scenario.key} offers an independent, testable approach with explicit assumptions.`, confidence: 0.72 }] };
  if (scenario.stage === "critique") return { summary, insights: [{ id: scenario.key, kind: "critique" as const, content: "The proposals need a bounded validation step before execution.", confidence: 0.81, references }] };
  return { summary, insights: [{ id: scenario.key, kind: "synthesis" as const, content: "Use the strongest proposal, gated by the reviewer's bounded validation step.", confidence: 0.88, references }], completionProposal: { reason: "Independent proposals and reviewer challenge were synthesized with verified runtime evidence." } };
}

function parseScenario(prompt: string): Scenario | undefined {
  const match = prompt.match(/^\[agentweave template=([^\s]+) phase=(lead|planning|execution|review|complete) recipient=([^\s]+) lead=([^\s]+) planning=([^\s]+) execution=([^\s]+) review=([^\]]+)\]/);
  if (!match) return undefined;
  const [, template, phase, recipient, lead, planning, execution, review] = match;
  return { template: template!, phase: phase as Scenario["phase"], recipient: recipient!, lead: lead!, planning: planning!, execution: execution!, review: review! };
}

function scenarioMarker(scenario: Scenario, phase: Scenario["phase"], recipient: string): string {
  return `[agentweave template=${scenario.template} phase=${phase} recipient=${recipient} lead=${scenario.lead} planning=${scenario.planning} execution=${scenario.execution} review=${scenario.review}]`;
}

function scenarioResult(scenario: Scenario, summary: string, qa?: "pass" | "fail") {
  if (qa === "fail" && scenario.phase === "review") return { summary, humanBlock: { question: "The deterministic review scenario failed.", context: summary } };
  if (scenario.phase === "complete") return { summary, completionProposal: { reason: `${scenario.template} scenario completed with a reviewed result.` } };
  const next = scenario.phase === "lead"
    ? { phase: "planning" as const, role: scenario.planning, title: "Frame the next actionable plan" }
    : scenario.phase === "planning"
      ? { phase: "execution" as const, role: scenario.execution, title: "Produce the requested artifact and evidence" }
      : scenario.phase === "execution"
        ? { phase: "review" as const, role: scenario.review, title: "Review the artifact and supporting evidence" }
        : { phase: "complete" as const, role: scenario.lead, title: "Assess the reviewed outcome for Human approval" };
  const taskId = `${scenario.phase}-next`;
  return {
    summary,
    insights: [{ id: `${scenario.phase}-insight`, content: `${scenario.recipient} contributed a ${scenario.phase} insight for ${scenario.template}.` }],
    tasks: [{ id: taskId, title: next.title, ownerRole: next.role, acceptanceCriteria: [`${next.role} produces an auditable ${next.phase} result`] }],
    messages: [{ recipientRole: next.role, messageType: "request" as const, taskId, content: `${scenarioMarker(scenario, next.phase, next.role)}\nContinue the ${scenario.template} scenario.` }],
  };
}

function demoStructuredResult(prompt: string, summary: string, qa?: "pass" | "fail") {
  if (qa === "fail") return { summary, humanBlock: { question: "QA reported a failure; review the failed checks.", context: summary } };
  if (prompt.includes("QA review completed successfully:")) return { summary, completionProposal: { reason: summary } };
  const next = prompt.startsWith("PM decomposition:")
    ? { role: "backend", title: "Implement the approved document model", content: "Implementation task and acceptance criteria: Implement the markdown editor with separate document state and preview rendering." }
    : prompt.startsWith("Implementation task and acceptance criteria:")
      ? { role: "qa", title: "Review implementation, tests, and evidence", content: "Review implementation, tests, and evidence: Check document state, preview rendering and keyboard accessibility." }
      : prompt.startsWith("Review implementation, tests, and evidence:")
        ? { role: "pm", title: "Review QA outcome for Human approval", content: "QA review completed successfully: Document model, preview and accessibility checks passed." }
        : undefined;
  return next ? { summary,
    tasks: [{ id: "next", title: next.title, ownerRole: next.role }],
    messages: [{ recipientRole: next.role, taskId: "next", content: next.content, messageType: "request" }],
  } : { summary };
}

/**
 * Keep the local demo deterministic and bounded. Echoing orchestration prompts
 * makes the PM parser mistake quoted numbered instructions for new tasks and
 * can create an unbounded loop after QA returns to the PM.
 */
function demoResponse(prompt: string): string {
  if (prompt.includes("QA review completed successfully:")) {
    return "[PROPOSE_COMPLETE] Demo workflow completed: the note editor plan, implementation handoff, and QA review all passed.";
  }
  if (prompt.includes("You are the PM and intelligent orchestrator")) {
    return [
      "[PE] Define the markdown note document model and accessibility requirements",
      "[CODER] Implement the small markdown note editor and preview",
      "[QA] Add focused accessibility and formatting checks",
    ].join("\n");
  }
  if (prompt.startsWith("PM decomposition:")) return "Implementation plan refined and ready for the coder.";
  if (prompt.startsWith("Implementation task and acceptance criteria:")) return "Implementation completed with the requested editor behavior.";
  if (prompt.startsWith("Review implementation, tests, and evidence:")) return "QA passed: implementation, tests, and evidence are ready for Human review.";
  return `Mock response: ${prompt}`;
}

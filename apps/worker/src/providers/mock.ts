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


/**
 * VC-demo v4 narrative: fictional podcast "Ship It" production workflow debate.
 * Content generated by real LLM (Codex/GPT) via `codex exec` on 2026-10-07,
 * pinned here for deterministic recording. Triggered when goal mentions "podcast".
 */
function demoNarrativeV4(prompt: string, scenario: CollaborationScenario, references: string[]) {
  const goalMatch = prompt.match(/^Goal: (.+)$/m);
  const isDemo = /podcast/i.test(prompt) || /Ship It/.test(prompt) || /45-minute/.test(prompt) || /90-minute episode/.test(prompt);
  if (!isDemo) return undefined;
  const p1 = { summary: "Ship It should run a clip-first, three-episode weekly production engine.", content: "Record three 45-minute remote interviews weekly, then edit each into one polished episode and three standalone 15-minute vertical clips for TikTok and Reels. Batch booking, recording, transcription, editing, captions, and approvals on fixed days; publish clips before full episodes to test hooks and retarget viewers. Assumption: each guest supplies at least three strong technical stories with clear, searchable takeaways.", confidence: 0.94 };
  const p2 = { summary: "Ship It should prioritize biweekly, research-heavy 90-minute interviews over high-volume clips.", content: "Publish one 90-minute episode every two weeks, assuming a three-person team can dedicate roughly 60 production hours per release. Spend the cycle researching the guest, mapping technical decisions, recording, fact-checking, and editing for narrative clarity. Build distribution around transcripts, show notes, and newsletters. Avoid clip-chasing: it distorts interviews toward performative sound bites, adds editing overhead, and attracts shallow, low-retention audiences.", confidence: 0.95 };
  const critique = { summary: "Both workflows mistake output strategy for a sustainable production system.", content: "Both plans optimize one metric while externalizing the host's labor and recovery needs. Growth ignores booking churn, prep, recording, editing, approvals, platform volatility, and the creative exhaustion of manufacturing clip-worthy moments three times weekly. Quality ignores research sprawl, perfectionism, fragile release cadence, audience attrition, and the emotional load of high-stakes interviews. Neither budgets holidays, illness, batching, delegation, format variety, or a sustainable pilot with burnout thresholds.", confidence: 0.98 };
  const rebut1 = { summary: "Rebuttal: Clip-first production makes three episodes weekly sustainable.", content: "Three weekly episodes are sustainable because clip-first changes production, not merely promotion: record one 90-minute batch session, structure each episode around two reusable segments, and publish from a four-week buffer. Host time stays capped at three hours weekly, while editors create 12–18 clips. If the buffer drops below two weeks, temporarily reduce output to two episodes.", confidence: 0.93 };
  const rebut2 = { summary: "Rebuttal: Depth creates differentiation while an always-on distribution layer drives discovery.", content: "A biweekly deep dive is not anti-growth; it is a differentiation strategy. Ship It competes better through memorable fictional cases, rigorous editing, and clips that travel than through forgettable weekly episodes. Discovery happens between releases: publish three short clips, a mock interview prompt, guest cross-posts, and an email teaser weekly. Measure completion, shares, and subscriber conversion before increasing cadence.", confidence: 0.94 };
  const synth = { summary: "Decision: Adopt a sustainable biweekly deep-dive season with clip-based distribution.", content: "Ship It will publish one deeply researched interview every two weeks, supported by three short clips cut from that episode and released across the following fortnight. Batch recording and editing will cap host production time at six hours per episode, with one planned off-week each quarter. For the first 12-week season, success means at least 80% on-time releases, no missed off-weeks, and median 30-day completion above 55%. Reassess cadence only after the season.", confidence: 0.96 };

  if (scenario.stage === "proposal") {
    const isRebuttal = scenario.key === "proposal-3" || scenario.key === "proposal-4";
    const c = scenario.key === "proposal-1" ? p1 : scenario.key === "proposal-2" ? p2 : scenario.key === "proposal-3" ? rebut1 : rebut2;
    return { summary: c.summary, insights: [{ id: scenario.key, kind: "proposal" as const, content: c.content, confidence: c.confidence }] };
  }
  if (scenario.stage === "critique") {
    // Return critique + both rebuttals as a back-and-forth in one round
    return { summary: critique.summary, insights: [
      { id: scenario.key, kind: "critique" as const, content: critique.content, confidence: critique.confidence, references },
      { id: "rebuttal-1", kind: "proposal" as const, content: rebut1.content, confidence: rebut1.confidence },
      { id: "rebuttal-2", kind: "proposal" as const, content: rebut2.content, confidence: rebut2.confidence },
    ] };
  }
  return {
    summary: synth.summary,
    insights: [{ id: scenario.key, kind: "synthesis" as const, content: synth.content, confidence: synth.confidence, references }],
    completionProposal: { reason: "Four-stage debate with human steer produced a sustainable, evidence-backed decision." },
  };
}

function collaborationResult(scenario: CollaborationScenario, prompt: string, summary: string) {
  const referencesMatch = prompt.match(/references (\[[^\n]+\])/);
  const references = referencesMatch ? JSON.parse(referencesMatch[1]!) as string[] : [];
  const v4 = demoNarrativeV4(prompt, scenario, references);
  if (v4) return v4;
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

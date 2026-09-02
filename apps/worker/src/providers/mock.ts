import { providerError } from "./errors.js";
import { agentTurnResultSchema } from "@agentweave/protocol";
import type { ProviderAdapter, ProviderCapabilities, ProviderRunEvent, ProviderRunInput, ProviderRunResult, ProviderSession, SessionCheckpoint } from "./types.js";

export class MockProviderAdapter implements ProviderAdapter {
  readonly name = "mock";
  readonly capabilities: ProviderCapabilities = { streaming: true, toolCalls: true, resume: true, cancellation: true };
  private readonly completed = new Map<string, ProviderRunResult>();
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
    const text = this.options.qa === "fail" ? "QA review: fail" : demoResponse(input.input);
    yield { type: "turn.delta", turnId, text }; yield { type: "turn.completed", turnId, text };
    const structuredResult = agentTurnResultSchema.parse({ summary: text });
    const result: ProviderRunResult = { turnId, text, structuredResult, session: { ...session, providerTurnId: turnId, status: "completed" as const, updatedAt: new Date().toISOString() } }; this.completed.set(turnId, result); return result;
  }
  async *cancel(_session: ProviderSession, turnId: string, correlationId?: string): AsyncGenerator<ProviderRunEvent> { yield { type: "turn.cancelled", turnId, ...(correlationId ? { correlationId } : {}) }; }
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

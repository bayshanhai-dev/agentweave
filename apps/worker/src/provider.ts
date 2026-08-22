export type AgentRole = "pm" | "pe" | "coder" | "qa";

export type ProviderSession = {
  provider: string;
  providerSessionId: string;
  agentInstanceId: string;
  role: AgentRole;
};

export type ProviderEvent =
  | { type: "session.created"; session: ProviderSession }
  | { type: "turn.started"; turnId: string }
  | { type: "turn.delta"; turnId: string; text: string }
  | { type: "turn.completed"; turnId: string; text: string }
  | { type: "turn.cancelled"; turnId: string };

export type ProviderTurn = {
  turnId: string;
  text: string;
  metadata: { nextRole?: AgentRole; outcome?: "pass" | "fail" | "review" };
};

export type CollaborationMessage = { from: AgentRole; to: AgentRole | "human"; type: "question" | "request" | "directive" | "command" | "decision" | "reply"; content: string; evidenceIds?: string[] };

export interface AiToolAdapter {
  create(role: AgentRole, sessionId: string): Promise<ProviderSession>;
  resume(session: ProviderSession): Promise<ProviderSession>;
  send(session: ProviderSession, input: string): AsyncGenerator<ProviderEvent, ProviderTurn>;
  cancel(session: ProviderSession, turnId: string): AsyncGenerator<ProviderEvent>;
  collaborate(session: ProviderSession, input: string): AsyncGenerator<ProviderEvent, CollaborationMessage>;
}

const nextRole: Partial<Record<AgentRole, AgentRole>> = {
  pm: "pe",
  pe: "coder",
  coder: "qa",
};

export class MockProvider implements AiToolAdapter {
  constructor(private readonly failQaOnce = false) {}

  async create(role: AgentRole, sessionId: string): Promise<ProviderSession> {
    return { provider: "mock", providerSessionId: `mock:${sessionId}`, agentInstanceId: sessionId, role };
  }

  async resume(session: ProviderSession): Promise<ProviderSession> {
    return session;
  }

  async *send(session: ProviderSession, input: string): AsyncGenerator<ProviderEvent, ProviderTurn> {
    const turnId = `${session.providerSessionId}:turn:${input.length}`;
    const outcome = session.role === "qa" ? (this.failQaOnce ? "fail" : "pass") : undefined;
    const text = this.response(session.role, input, outcome);
    yield { type: "turn.started", turnId };
    for (const chunk of text.match(/.{1,24}/g) ?? []) yield { type: "turn.delta", turnId, text: chunk };
    yield { type: "turn.completed", turnId, text };
    return {
      turnId,
      text,
      metadata: {
        ...(nextRole[session.role] ? { nextRole: nextRole[session.role] } : {}),
        ...(outcome ? { outcome } : {}),
      },
    };
  }

  async *cancel(_session: ProviderSession, turnId: string): AsyncGenerator<ProviderEvent> {
    yield { type: "turn.cancelled", turnId };
  }

  async *collaborate(session: ProviderSession, input: string): AsyncGenerator<ProviderEvent, CollaborationMessage> {
    const run = yield* this.send(session, input);
    const next = nextRole[session.role] ?? "human";
    return { from: session.role, to: next, type: session.role === "qa" ? "decision" : "request", content: run.text, ...(session.role === "coder" ? { evidenceIds: [`${run.turnId}:evidence`] } : {}) };
  }

  private response(role: AgentRole, input: string, outcome?: "pass" | "fail"): string {
    if (role === "pm") return `PM plan: break the goal into one implementation task. Goal: ${input}`;
    if (role === "pe") return `PE design: define the smallest testable implementation for ${input}`;
    if (role === "coder") return `Coder implementation: completed the requested change for ${input}`;
    return outcome === "fail" ? "QA review: fail; missing acceptance evidence" : "QA review: pass; acceptance evidence attached";
  }
}

/** Backwards-compatible name while integrations migrate to the generic adapter contract. */
export type AgentSessionProvider = AiToolAdapter;

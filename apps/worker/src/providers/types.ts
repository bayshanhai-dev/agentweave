export type ProviderStatus = "active" | "completed" | "failed" | "cancelled" | (string & {});
export type RetryClass = "retryable" | "non-retryable" | "user-action-required";

export type ProviderCapabilities = {
  streaming: boolean; toolCalls: boolean; resume: boolean; cancellation: boolean;
};

/** Usage is only populated when the provider reports it. AgentWeave never fabricates cost. */
export type ProviderUsage = {
  source: "provider" | "estimated" | "unknown";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

export type ProviderSession = {
  provider: string; model?: string; workspacePath?: string; providerSessionId: string; providerTurnId?: string;
  status: ProviderStatus; createdAt: string; updatedAt: string; lastError?: ProviderError;
};

export type SessionCheckpoint = {
  provider: string; providerSessionId: string; providerTurnId?: string;
  sequence: number; state: Record<string, unknown>; createdAt: string;
};

export type ProviderRunInput = {
  input: string; model?: string; session?: ProviderSession; idempotencyKey?: string;
  correlationId?: string; workspacePath?: string;
};

export type ProviderRunEvent =
  | { type: "session.started" | "session.resumed"; session: ProviderSession; correlationId?: string }
  | { type: "turn.started"; turnId: string; correlationId?: string }
  | { type: "turn.delta"; turnId: string; text: string; correlationId?: string }
  | { type: "tool.started"; turnId: string; toolName: string; toolCallId?: string; correlationId?: string }
  | { type: "tool.completed"; turnId: string; toolName: string; toolCallId?: string; output?: string; correlationId?: string }
  | { type: "turn.completed"; turnId: string; text: string; usage?: ProviderUsage; correlationId?: string }
  | { type: "usage.updated"; turnId: string; usage: ProviderUsage; correlationId?: string }
  | { type: "turn.failed"; turnId: string; error: ProviderError; correlationId?: string }
  | { type: "turn.cancelled"; turnId: string; correlationId?: string }
  | { type: "provider.error"; error: ProviderError; correlationId?: string };

export type ProviderRunResult = { turnId: string; text: string; session: ProviderSession; usage?: ProviderUsage; metadata?: Record<string, unknown> };

export type ProviderError = {
  code: string; message: string; category: "timeout" | "cancelled" | "transport" | "authentication" | "configuration" | "provider" | "unknown";
  retry: RetryClass; provider?: string; statusCode?: number; correlationId?: string;
};

export interface ProviderAdapter {
  readonly name: string; readonly capabilities: ProviderCapabilities;
  createSession(input?: { model?: string; workspacePath?: string; correlationId?: string }): Promise<ProviderSession>;
  resumeSession(session: ProviderSession, correlationId?: string): Promise<ProviderSession>;
  checkpoint(session: ProviderSession): Promise<SessionCheckpoint>;
  run(input: ProviderRunInput): AsyncGenerator<ProviderRunEvent, ProviderRunResult>;
  cancel(session: ProviderSession, turnId: string, correlationId?: string): AsyncGenerator<ProviderRunEvent>;
}

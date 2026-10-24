import { describe, expect, it, vi } from "vitest";
import { ProviderAdapterRegistry } from "../../src/providers/registry.js";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderRunEvent,
  ProviderRunInput,
  ProviderRunResult,
  ProviderSession,
  SessionCheckpoint,
} from "../../src/providers/types.js";
import type { AgentSessionRepository } from "../../src/providers/session-repository.js";
import { AgentTaskExecutor } from "../../src/runtime/execution.js";

const sessions = (): AgentSessionRepository => ({
  listUnfinished: vi.fn(async () => []),
  save: vi.fn(async () => {}),
  acquireLease: vi.fn(async () => true),
  releaseLease: vi.fn(async () => {}),
  claimTask: vi.fn(async () => true),
  finishTask: vi.fn(async () => {}),
});

class TestAdapter implements ProviderAdapter {
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalls: false,
    resume: true,
    cancellation: true,
  };
  readonly inputs: ProviderRunInput[] = [];

  constructor(readonly name: string, private readonly rendezvous: () => Promise<void>) {}

  async createSession(input: { model?: string } = {}): Promise<ProviderSession> {
    const now = new Date().toISOString();
    return {
      provider: this.name,
      ...(input.model ? { model: input.model } : {}),
      providerSessionId: `${this.name}-session`,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
  }

  async resumeSession(session: ProviderSession): Promise<ProviderSession> { return session; }
  async checkpoint(session: ProviderSession): Promise<SessionCheckpoint> {
    return { provider: this.name, providerSessionId: session.providerSessionId, sequence: 1, state: {}, createdAt: new Date().toISOString() };
  }
  async *run(input: ProviderRunInput): AsyncGenerator<ProviderRunEvent, ProviderRunResult> {
    this.inputs.push(input);
    await this.rendezvous();
    const session = input.session ?? await this.createSession(input.model ? { model: input.model } : {});
    const turnId = `${this.name}-turn`;
    yield { type: "turn.started", turnId };
    const usage = { source: "provider" as const, totalTokens: this.name === "codex" ? 11 : 22 };
    yield { type: "turn.completed", turnId, text: `${this.name} complete`, usage };
    return { turnId, text: `${this.name} complete`, usage, session: { ...session, status: "completed" } };
  }
  async *cancel(_session: ProviderSession, turnId: string): AsyncGenerator<ProviderRunEvent> {
    yield { type: "turn.cancelled", turnId };
  }
}

describe("per-turn provider adapter routing", () => {
  it("executes concurrent stamped turns through their corresponding lazy adapters", async () => {
    let arrivals = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    const rendezvous = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothStarted;
    };
    const codex = new TestAdapter("codex", rendezvous);
    const ollama = new TestAdapter("ollama", rendezvous);
    const codexFactory = vi.fn(() => codex);
    const ollamaFactory = vi.fn(() => ollama);
    const registry = new ProviderAdapterRegistry("codex", { codex: codexFactory, ollama: ollamaFactory });
    const sink = vi.fn(async () => {});
    const executor = new AgentTaskExecutor(registry, sessions(), "worker", sink);

    await Promise.all([
      executor.execute({ taskId: "critique", agentId: "showrunner", workstreamId: "podcast", provider: "codex", model: "gpt-5.6-sol", prompt: "Critique" }),
      executor.execute({ taskId: "edit", agentId: "editor", workstreamId: "podcast", provider: "ollama", model: "llama3.1:8b", prompt: "Edit" }),
    ]);

    expect(codexFactory).toHaveBeenCalledOnce();
    expect(ollamaFactory).toHaveBeenCalledOnce();
    expect(codex.inputs[0]?.model).toBe("gpt-5.6-sol");
    expect(ollama.inputs[0]?.model).toBe("llama3.1:8b");
    expect(sink.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "task.completed", provider: "codex", model: "gpt-5.6-sol", usage: expect.objectContaining({ totalTokens: 11 }) }),
      expect.objectContaining({ type: "task.completed", provider: "ollama", model: "llama3.1:8b", usage: expect.objectContaining({ totalTokens: 22 }) }),
    ]));
  });

  it("uses the environment-selected default only for an unstamped turn", async () => {
    const adapter = new TestAdapter("ollama", async () => {});
    const registry = new ProviderAdapterRegistry("ollama", { ollama: () => adapter }, "llama-env-default");
    const sink = vi.fn(async () => {});
    await new AgentTaskExecutor(registry, sessions(), "worker", sink).execute({
      taskId: "legacy",
      agentId: "editor",
      prompt: "Legacy unstamped delivery",
    });
    expect(sink.mock.calls.map((call) => call[0])).toContainEqual(
      expect.objectContaining({ type: "task.completed", provider: "ollama", model: "llama-env-default" }),
    );
    expect(adapter.inputs[0]?.model).toBe("llama-env-default");

    await new AgentTaskExecutor(registry, sessions(), "worker", sink).execute({
      taskId: "stamped-without-model",
      agentId: "host",
      provider: "ollama",
      prompt: "Use the provider's native default",
    });
    expect(adapter.inputs[1]?.model).toBeUndefined();
  });
});

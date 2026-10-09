import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTaskExecutor, resolveMaxTurns } from "../../src/runtime/execution.js";
import { MockProviderAdapter } from "../../src/providers/mock.js";
import type { AgentSessionRepository } from "../../src/providers/session-repository.js";

const sessions = (): AgentSessionRepository => ({
  listUnfinished: vi.fn(async () => []),
  save: vi.fn(async () => {}),
  acquireLease: vi.fn(async () => true),
  releaseLease: vi.fn(async () => {}),
  claimTask: vi.fn(async () => true),
  finishTask: vi.fn(async () => {}),
});

type SinkEvent = {
  type: string;
  turnId?: string;
  text?: string;
  structuredResult?: { completionProposal?: { reason?: string }; messages?: unknown[] };
  turns?: Array<{ turnId: string; text: string; structuredResult?: { completionProposal?: { reason?: string } } }>;
  turnBudgetExhausted?: boolean;
};

const eventsOf = (sink: ReturnType<typeof vi.fn>, type: string): SinkEvent[] =>
  sink.mock.calls
    .map((call: unknown[]) => call[0] as SinkEvent)
    .filter((event) => event.type === type);

const eventTypes = (sink: ReturnType<typeof vi.fn>): string[] =>
  sink.mock.calls.map((call: unknown[]) => (call[0] as SinkEvent).type);

const previousMaxTurns = process.env.AGENT_MAX_TURNS;
afterEach(() => {
  if (previousMaxTurns === undefined) delete process.env.AGENT_MAX_TURNS;
  else process.env.AGENT_MAX_TURNS = previousMaxTurns;
});

describe("resolveMaxTurns", () => {
  it("defaults to 5", () => {
    delete process.env.AGENT_MAX_TURNS;
    expect(resolveMaxTurns()).toBe(5);
  });
  it("honors AGENT_MAX_TURNS", () => {
    process.env.AGENT_MAX_TURNS = "2";
    expect(resolveMaxTurns()).toBe(2);
  });
  it.each(["0", "-3", "nope", ""])("falls back to 5 for %s", (value) => {
    process.env.AGENT_MAX_TURNS = value;
    expect(resolveMaxTurns()).toBe(5);
  });
});

describe("agent-owned multi-turn execution", () => {
  it("stops after the first turn when the model proposes completion immediately", async () => {
    const sink = vi.fn(async () => {});
    await new AgentTaskExecutor(
      new MockProviderAdapter(),
      sessions(),
      "worker",
      sink,
    ).execute({
      taskId: "immediate",
      agentId: "pm",
      prompt: "QA review completed successfully: all checks passed.",
    });
    expect(eventsOf(sink, "turn.started")).toHaveLength(1);
    const [completed] = eventsOf(sink, "task.completed");
    expect(completed?.structuredResult).toMatchObject({
      completionProposal: { reason: expect.any(String) },
    });
    expect(completed?.turnBudgetExhausted).toBeUndefined();
  });

  it("renews the session lease after every completed turn", async () => {
    const repository = sessions();
    const sink = vi.fn(async () => {});
    await new AgentTaskExecutor(new MockProviderAdapter(), repository, "worker", sink).execute({
      taskId: "lease-renewal",
      agentId: "pm",
      prompt: "[agentweave multiturn=twoturn]\nFinish in two turns.",
    });
    expect(repository.acquireLease).toHaveBeenCalledTimes(4);
  });

  it("fails cleanly when the session lease is lost between turns", async () => {
    const repository = sessions();
    vi.mocked(repository.acquireLease).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const sink = vi.fn(async () => {});
    await expect(new AgentTaskExecutor(new MockProviderAdapter(), repository, "worker", sink).execute({
      taskId: "lease-lost",
      agentId: "pm",
      prompt: "[agentweave multiturn=twoturn]\nFinish in two turns.",
    })).rejects.toThrow("Session lease lost");
    expect(eventsOf(sink, "task.failed")).toHaveLength(1);
    expect(eventsOf(sink, "task.completed")).toHaveLength(0);
    expect(vi.mocked(repository.save).mock.calls.every(([record]) => record.status === "active")).toBe(true);
  });

  it("runs a second turn and stops on the completion signal", async () => {
    const sink = vi.fn(async () => {});
    await new AgentTaskExecutor(
      new MockProviderAdapter(),
      sessions(),
      "worker",
      sink,
    ).execute({
      taskId: "twoturn",
      agentId: "pm",
      prompt: "[agentweave multiturn=twoturn]\nFinish in two turns.",
    });
    expect(eventsOf(sink, "turn.started")).toHaveLength(2);
    const [completed] = eventsOf(sink, "task.completed");
    expect(completed?.structuredResult).toMatchObject({
      completionProposal: {
        reason: "Two-turn scenario completed with a verified result.",
      },
    });
    expect(completed?.turns).toHaveLength(2);
    expect(completed?.turns?.[0]?.structuredResult).toBeDefined();
    expect(completed?.turns?.[1]?.structuredResult).toMatchObject({
      completionProposal: { reason: "Two-turn scenario completed with a verified result." },
    });
    expect(completed?.turnBudgetExhausted).toBeUndefined();
  });

  it("stops at the turn budget and marks partial results without failing", async () => {
    process.env.AGENT_MAX_TURNS = "1";
    const sink = vi.fn(async () => {});
    await new AgentTaskExecutor(
      new MockProviderAdapter(),
      sessions(),
      "worker",
      sink,
    ).execute({
      taskId: "budget",
      agentId: "pm",
      prompt: "[agentweave multiturn=twoturn]\nFinish in two turns.",
    });
    expect(eventsOf(sink, "turn.started")).toHaveLength(1);
    const [completed] = eventsOf(sink, "task.completed");
    expect(completed?.turnBudgetExhausted).toBe(true);
    expect(eventTypes(sink)).not.toContain("task.failed");
  });

  it("keeps single-turn behavior for turns that do not opt into the loop", async () => {
    const sink = vi.fn(async () => {});
    await new AgentTaskExecutor(
      new MockProviderAdapter(),
      sessions(),
      "worker",
      sink,
    ).execute({
      taskId: "legacy",
      agentId: "pm",
      prompt: "You are the PM and intelligent orchestrator",
    });
    expect(eventsOf(sink, "turn.started")).toHaveLength(1);
    const [completed] = eventsOf(sink, "task.completed");
    expect(completed?.structuredResult).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ recipientRole: "pe" }),
      ]),
    });
  });
});

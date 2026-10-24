import { describe, expect, it, vi } from "vitest";
import { MockProviderAdapter } from "../../src/providers/mock.js";
import type { AgentSessionRepository } from "../../src/providers/session-repository.js";
import { AgentTaskExecutor } from "../../src/runtime/execution.js";
import { ExecutionControl, ExecutionGatedError } from "../../src/runtime/execution-control.js";

const sessions = (): AgentSessionRepository => ({
  listUnfinished: vi.fn(async () => []),
  save: vi.fn(async () => {}),
  acquireLease: vi.fn(async () => true),
  releaseLease: vi.fn(async () => {}),
  claimTask: vi.fn(async () => true),
  finishTask: vi.fn(async () => {}),
});

describe("gated execution", () => {
  it("reports task.gated instead of task.failed when a human gate lands mid-run", async () => {
    const provider = new MockProviderAdapter();
    const control = new ExecutionControl();
    const originalRun = provider.run.bind(provider);
    vi.spyOn(provider, "run").mockImplementation(async function* (input) {
      await control.update("waiting_for_human");
      yield* originalRun(input);
    });
    const repository = sessions();
    const sink = vi.fn(async () => {});

    await expect(
      new AgentTaskExecutor(provider, repository, "worker", sink).execute(
        { taskId: "gated-task", agentId: "qa", workstreamId: "ws-gated", prompt: "Validate the project." },
        control,
      ),
    ).rejects.toBeInstanceOf(ExecutionGatedError);

    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ type: "task.gated", taskId: "gated-task" }));
    expect(sink).not.toHaveBeenCalledWith(expect.objectContaining({ type: "task.failed" }));
    expect(repository.save).not.toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("carries a completed structured decision when the gate lands before task completion is published", async () => {
    const provider = new MockProviderAdapter();
    const control = new ExecutionControl();
    const structuredResult = {
      schemaVersion: 1 as const,
      summary: "Produce the podcast deliverables",
      insights: [],
      messages: [],
      tasks: [{
        id: "script",
        title: "Write the episode script",
        ownerRole: "writer",
        acceptanceCriteria: ["episode-script.md contains the complete script"],
        dependencies: [],
      }],
    };
    vi.spyOn(provider, "run").mockImplementation(async function* (input) {
      const session = input.session ?? await provider.createSession();
      const turnId = "completed-before-gate";
      const text = JSON.stringify(structuredResult);
      yield { type: "turn.started", turnId };
      yield { type: "turn.delta", turnId, text };
      yield { type: "turn.completed", turnId, text };
      return { turnId, text, structuredResult, session };
    });
    const sink = vi.fn(async (event: { type: string }) => {
      if (event.type === "turn.completed")
        await control.update("waiting_for_human");
    });

    await expect(
      new AgentTaskExecutor(provider, sessions(), "worker", sink).execute(
        {
          taskId: "trigger-execution-key",
          agentId: "showrunner",
          workstreamId: "ws-gated",
          prompt: "[agentweave implementation-trigger] decompose",
        },
        control,
      ),
    ).rejects.toBeInstanceOf(ExecutionGatedError);

    expect(sink).toHaveBeenCalledWith(expect.objectContaining({
      type: "task.gated",
      turnId: "completed-before-gate",
      text: JSON.stringify(structuredResult),
      structuredResult,
    }));
    expect(sink).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "task.completed" }),
    );
  });
});

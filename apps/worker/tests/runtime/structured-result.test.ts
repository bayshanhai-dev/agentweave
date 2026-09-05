import { describe, expect, it, vi } from "vitest";
import { AgentTaskExecutor } from "../../src/runtime/execution.js";
import { MockProviderAdapter } from "../../src/providers/mock.js";
import type { ProviderRunResult } from "../../src/providers/types.js";
import type { AgentSessionRepository } from "../../src/providers/session-repository.js";

const sessions = (): AgentSessionRepository => ({
  listUnfinished: vi.fn(async () => []),
  save: vi.fn(async () => {}),
  acquireLease: vi.fn(async () => true),
  releaseLease: vi.fn(async () => {}),
  claimTask: vi.fn(async () => true),
  finishTask: vi.fn(async () => {}),
});

describe("structured provider execution", () => {
  it("forwards Mock insights, task proposals, messages, and stable turn identity", async () => {
    const sink = vi.fn(async () => {});
    await new AgentTaskExecutor(
      new MockProviderAdapter(),
      sessions(),
      "worker",
      sink,
    ).execute({
      taskId: "bootstrap",
      agentId: "pm",
      prompt: "You are the PM and intelligent orchestrator",
      idempotencyKey: "delivery",
    });
    expect(sink.mock.calls.map((call: unknown[]) => call[0])).toContainEqual(
      expect.objectContaining({
        type: "task.completed",
        turnId: expect.stringContaining("delivery"),
        structuredResult: expect.objectContaining({
          insights: expect.arrayContaining([
            expect.objectContaining({ id: "editor-model" }),
          ]),
          messages: expect.arrayContaining([
            expect.objectContaining({ recipientRole: "pe", taskId: "design" }),
          ]),
        }),
      }),
    );
  });
  it.each([false, true])(
    "validates explicit and JSON text results before emitting task completion (malformed=%s)",
    async (malformed) => {
      const provider = new MockProviderAdapter();
      const base = provider.run.bind(provider);
      provider.run = async function* (input) {
        const generator = base(input);
        let step = await generator.next();
        while (!step.done) {
          yield step.value;
          step = await generator.next();
        }
        return {
          ...step.value,
          structuredResult: undefined,
          text: JSON.stringify({
            summary: "Review",
            messages: malformed
              ? "invalid"
              : [{ recipientRole: "qa", content: "Check" }],
          }),
        } as ProviderRunResult;
      };
      const sink = vi.fn(async () => {});
      const run = new AgentTaskExecutor(
        provider,
        sessions(),
        "worker",
        sink,
      ).execute({ taskId: "task", agentId: "pm", prompt: "test" });
      if (malformed) {
        await expect(run).rejects.toThrow(/Invalid structured/);
        expect(
          sink.mock.calls.map((call: unknown[]) => call[0]),
        ).not.toContainEqual(
          expect.objectContaining({ type: "task.completed" }),
        );
      } else {
        await run;
        expect(
          sink.mock.calls.map((call: unknown[]) => call[0]),
        ).toContainEqual(
          expect.objectContaining({
            type: "task.completed",
            structuredResult: expect.objectContaining({
              messages: [expect.objectContaining({ recipientRole: "qa" })],
            }),
          }),
        );
      }
    },
  );
});

import { describe, expect, it, vi } from "vitest";
import { MockProviderAdapter } from "../../src/providers/mock.js";
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

describe("provider failure execution events", () => {
  it("classifies a quota failure thrown during a provider run", async () => {
    const provider = new MockProviderAdapter();
    vi.spyOn(provider, "run").mockImplementation(async function* () {
      throw new Error("Usage limit reached; token=secret-value");
    });
    const sink = vi.fn(async () => {});

    await expect(new AgentTaskExecutor(provider, sessions(), "worker", sink).execute({
      taskId: "quota-task",
      agentId: "writer",
      prompt: "Write the draft.",
    })).rejects.toThrow("Usage limit reached");

    expect(sink).toHaveBeenCalledWith(expect.objectContaining({
      type: "task.failed",
      taskId: "quota-task",
      error: "Usage limit reached; token=[REDACTED]",
      errorCategory: "rate_limit",
      errorCode: "PROVIDER_USAGE_LIMIT",
      errorRetry: "user-action-required",
    }));
  });

  it("classifies an authentication failure thrown during session setup", async () => {
    const provider = new MockProviderAdapter();
    vi.spyOn(provider, "createSession").mockRejectedValue(new Error("Invalid API key api_key=secret-value"));
    const sink = vi.fn(async () => {});

    await expect(new AgentTaskExecutor(provider, sessions(), "worker", sink).execute({
      taskId: "auth-task",
      agentId: "writer",
      prompt: "Write the draft.",
    })).rejects.toThrow("Invalid API key");

    expect(sink).toHaveBeenCalledWith(expect.objectContaining({
      type: "task.failed",
      taskId: "auth-task",
      error: "Invalid API key api_key=[REDACTED]",
      errorCategory: "authentication",
      errorCode: "PROVIDER_AUTHENTICATION",
      errorRetry: "user-action-required",
    }));
  });
});

import { describe, expect, it } from "vitest";
import { actualProviderForAgent, actualProviderForWorkstream, displayProviderForAgent, displayProviderForWorkstream } from "../src/provider-runtime.js";

describe("observed provider display", () => {
  const events = [
    { type: "run.started", agentId: "qa-1", provider: "ollama", model: "llama3.1:8b", occurredAt: "2026-11-10T10:00:00Z" },
    { type: "run.started", agentId: "qa-1", provider: "codex", model: "gpt-5.6-luna", occurredAt: "2026-11-10T10:01:00Z" },
  ];

  it("uses the newest provider reported by the worker", () => {
    expect(actualProviderForAgent(events, "qa-1")).toEqual({ provider: "codex", model: "gpt-5.6-luna" });
    expect(actualProviderForWorkstream(events)).toEqual({ tool: "codex", model: "gpt-5.6-luna" });
  });

  it("does not substitute the configured template provider when no worker signal exists", () => {
    expect(actualProviderForWorkstream([])).toEqual({});
  });

  it("falls back to the configured provider when no worker signal exists", () => {
    expect(displayProviderForWorkstream([], { tool: "codex", model: "gpt-5.6-luna" })).toEqual({ tool: "codex", model: "gpt-5.6-luna" });
    expect(displayProviderForAgent([], "qa-1", { provider: "codex", model: "gpt-5.6-luna" })).toEqual({ provider: "codex", model: "gpt-5.6-luna" });
  });

  it("lets the observed worker provider override the configured one", () => {
    expect(displayProviderForWorkstream(events, { tool: "codex", model: "gpt-5.6-luna" })).toEqual({ tool: "codex", model: "gpt-5.6-luna" });
    const ollamaEvents = [{ type: "run.started", agentId: "qa-1", provider: "ollama", model: "llama3.1:8b", occurredAt: "2026-11-10T10:02:00Z" }];
    expect(displayProviderForWorkstream(ollamaEvents, { tool: "codex", model: "gpt-5.6-luna" })).toEqual({ tool: "ollama", model: "llama3.1:8b" });
    expect(displayProviderForAgent(ollamaEvents, "qa-1", { provider: "codex", model: "gpt-5.6-luna" })).toEqual({ provider: "ollama", model: "llama3.1:8b" });
  });
});

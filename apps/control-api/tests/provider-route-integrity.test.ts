import { describe, expect, it } from "vitest";
import { isEmptyProviderTurn, providerRouteMismatch } from "../src/provider-route-integrity.js";

describe("provider route integrity", () => {
  it("rejects a role override that silently became a worker fallback", () => {
    expect(providerRouteMismatch({ role: "qa" }, { qa: { tool: "codex" } }, { provider: "ollama" }))
      .toContain("expected codex");
    expect(providerRouteMismatch({ role: "qa" }, { qa: { tool: "codex" } }, { provider: "codex" })).toBeUndefined();
  });

  it("classifies an empty zero-usage request turn as failed", () => {
    expect(isEmptyProviderTurn("", { inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toBe(true);
    expect(isEmptyProviderTurn("response", { inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toBe(false);
  });
});

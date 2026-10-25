import { describe, expect, it } from "vitest";
import {
  buildProviderAuthenticationMessage,
  buildProviderLimitMessage,
  providerFailureAction,
} from "../src/provider-failure.js";

describe("providerFailureAction", () => {
  it.each([
    { errorCategory: "rate_limit" },
    { errorCategory: "authentication" },
    { errorCategory: "configuration", errorRetry: "user-action-required" },
  ])("parks $errorCategory failures requiring Human action", (input) => {
    expect(providerFailureAction(input)).toBe("park-for-human");
  });

  it.each([
    {},
    { errorCategory: "timeout", errorRetry: "retryable" },
    { errorCategory: "provider", errorRetry: "non-retryable" },
  ])("leaves other failures on the default path", (input) => {
    expect(providerFailureAction(input)).toBe("default");
  });
});

const context = {
  provider: "codex",
  model: "gpt-5.6-codex",
  role: "writer",
  task: "Draft the launch post",
};

describe("provider failure messages", () => {
  it("explains how to resume after a provider limit resets", () => {
    const message = buildProviderLimitMessage(context);
    for (const value of Object.values(context)) expect(message).toContain(value);
    expect(message).toContain("parked, not failed");
    expect(message).toContain("Wait for the limit window to reset");
    expect(message).toContain("switch the writer role to another model");
    expect(message).toContain("approve/resume");
  });

  it("explains how to resume after signing the provider in again", () => {
    const message = buildProviderAuthenticationMessage(context);
    for (const value of Object.values(context)) expect(message).toContain(value);
    expect(message).toContain("parked, not failed");
    expect(message).toContain("Sign the provider in again");
    expect(message).toContain("approve/resume");
  });
});

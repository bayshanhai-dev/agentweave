import { describe, expect, it } from "vitest";
import { classifyProviderFailure } from "../../src/providers/errors.js";

describe("classifyProviderFailure", () => {
  it.each([
    "usage limit reached",
    "usage_limit reached",
    "quota exhausted",
    "limit reached for this account",
    "insufficient_quota",
    "billing is required",
  ])("classifies quota signal %j as requiring user action", (message) => {
    expect(classifyProviderFailure({ message })).toMatchObject({
      category: "rate_limit",
      retry: "user-action-required",
    });
  });

  it.each([
    { message: "request rejected", statusCode: 429 },
    { message: "rate limit exceeded" },
    { message: "rate_limit exceeded" },
    { message: "too many requests" },
  ])("classifies transient rate-limit signal $message", (input) => {
    expect(classifyProviderFailure(input)).toMatchObject({
      category: "rate_limit",
      retry: "retryable",
    });
  });

  it.each([
    { message: "request rejected", statusCode: 401 },
    { message: "request rejected", statusCode: 403 },
    { message: "unauthorized" },
    { message: "authentication failed" },
    { message: "refresh token expired" },
    { message: "invalid api key" },
    { message: "invalid_api_key" },
  ])("classifies authentication signal $message", (input) => {
    expect(classifyProviderFailure(input)).toMatchObject({
      category: "authentication",
      retry: "user-action-required",
    });
  });

  it.each(["timed out", "timeout", "ETIMEDOUT", "deadline exceeded"])(
    "classifies timeout signal %j",
    (message) => {
      expect(classifyProviderFailure({ message })).toMatchObject({
        category: "timeout",
        retry: "retryable",
      });
    },
  );

  it("prioritizes quota wording over a generic HTTP 429", () => {
    expect(classifyProviderFailure({ message: "quota exhausted", statusCode: 429 })).toMatchObject({
      category: "rate_limit",
      retry: "user-action-required",
    });
  });

  it("uses and redacts a provider code", () => {
    const result = classifyProviderFailure({
      message: "authentication failed",
      code: "api_key=super-secret",
    });
    expect(result?.code).toBe("api_key=[REDACTED]");
  });

  it("has no opinion about an unclassifiable error", () => {
    expect(classifyProviderFailure({ message: "the provider returned malformed output" })).toBeUndefined();
  });
});

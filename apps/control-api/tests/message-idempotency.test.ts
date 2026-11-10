import { describe, expect, it } from "vitest";
import { shouldPublishMessage } from "../src/message-idempotency.js";

describe("structured message replay idempotency", () => {
  it("publishes a stable turn message once and suppresses a replay", () => {
    const known = new Set<string>();
    expect(shouldPublishMessage("turn-1:message:0", known)).toBe(true);
    known.add("turn-1:message:0");
    expect(shouldPublishMessage("turn-1:message:0", known)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  implementationTriggerMarker,
  inboxStatusGateDecision,
} from "../src/inbox-status-gate.js";

describe("inboxStatusGateDecision", () => {
  it.each(["paused", "waiting_for_human", "completing", "emergency_stopped"])(
    "retries implementation-trigger flow messages while %s",
    (status) => {
      expect(inboxStatusGateDecision(status, `Re-prompt\n${implementationTriggerMarker}`)).toBe("retry");
    },
  );

  it("acknowledges other messages in a gated state", () => {
    expect(inboxStatusGateDecision("waiting_for_human", "ordinary task message")).toBe("ack");
  });

  it.each(["completed", "archived"])(
    "acknowledges implementation-trigger flow messages in terminal state %s",
    (status) => {
      expect(inboxStatusGateDecision(status, implementationTriggerMarker)).toBe("ack");
    },
  );
});

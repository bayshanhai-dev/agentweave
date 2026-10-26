import { describe, expect, it } from "vitest";
import {
  implementationTriggerMarker,
  inboxStatusGateDecision,
  isGatedWorkstreamStatus,
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

  it("re-drives the queued run 18 decomposition re-prompt after resume", () => {
    const reprompt = `Reply with a valid decomposition.\n${implementationTriggerMarker}`;

    expect(inboxStatusGateDecision("waiting_for_human", reprompt)).toBe(
      "retry",
    );
    expect(inboxStatusGateDecision("active", reprompt)).toBeUndefined();
  });

  it.each(["completed", "archived"])(
    "acknowledges implementation-trigger flow messages in terminal state %s",
    (status) => {
      expect(inboxStatusGateDecision(status, implementationTriggerMarker)).toBe("ack");
    },
  );
});

describe("isGatedWorkstreamStatus", () => {
  it.each(["paused", "waiting_for_human", "completing", "emergency_stopped"])(
    "treats parked state %s as gated",
    (status) => {
      expect(isGatedWorkstreamStatus(status)).toBe(true);
    },
  );

  it.each(["active", "draft", "starting", "completed", "archived", undefined])(
    "does not treat %s as gated",
    (status) => {
      expect(isGatedWorkstreamStatus(status)).toBe(false);
    },
  );
});

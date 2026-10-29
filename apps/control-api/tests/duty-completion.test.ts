import { describe, expect, it } from "vitest";
import { evaluateDutyCompletion } from "../src/duty-completion.js";

const noEvidence = {
  hasCompletionClaim: false,
  hasDutyState: false,
  hasAgentMessage: false,
  hasStructuredDeliverables: false,
};

describe("duty completion gate", () => {
  it("always accepts attestation mode", () => {
    expect(
      evaluateDutyCompletion({
        ...noEvidence,
        completionEvidence: "attestation",
      }),
    ).toEqual({ accepted: true });
  });

  it.each([
    "hasCompletionClaim",
    "hasDutyState",
    "hasAgentMessage",
    "hasStructuredDeliverables",
  ])("accepts deliverable mode with %s", (evidence) => {
    expect(
      evaluateDutyCompletion({
        ...noEvidence,
        completionEvidence: "deliverable",
        [evidence]: true,
      }),
    ).toEqual({ accepted: true });
  });

  it("rejects deliverable mode without evidence", () => {
    expect(
      evaluateDutyCompletion({
        ...noEvidence,
        completionEvidence: "deliverable",
      }),
    ).toEqual({
      accepted: false,
      reason:
        "duty produced no deliverable: no completion proposal, no duty-state update, no agent message, no structured deliverable",
    });
  });
});

export function evaluateDutyCompletion(input: {
  completionEvidence?: string;
  hasCompletionClaim: boolean;
  hasDutyState: boolean;
  hasAgentMessage: boolean;
  hasStructuredDeliverables: boolean;
}): { accepted: boolean; reason?: string } {
  if (input.completionEvidence !== "deliverable") return { accepted: true };
  if (
    input.hasCompletionClaim ||
    input.hasDutyState ||
    input.hasAgentMessage ||
    input.hasStructuredDeliverables
  )
    return { accepted: true };
  return {
    accepted: false,
    reason:
      "duty produced no deliverable: no completion proposal, no duty-state update, no agent message, no structured deliverable",
  };
}

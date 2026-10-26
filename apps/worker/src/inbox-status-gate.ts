export const implementationTriggerMarker = "[agentweave implementation-trigger]";

const retryableGatedStatuses = new Set([
  "paused",
  "waiting_for_human",
  "completing",
  "emergency_stopped",
]);

/**
 * True when the workstream is parked, so a message the gate signs for will
 * not start an agent turn. The worker reports those deliveries as `gated`
 * so the operator can tell a parked sign-off apart from real pickup.
 */
export function isGatedWorkstreamStatus(status: string | undefined): boolean {
  return retryableGatedStatuses.has(status ?? "");
}

const terminalStatuses = new Set(["completed", "archived"]);

export function inboxStatusGateDecision(
  status: string | undefined,
  content: string | undefined,
): "ack" | "retry" | undefined {
  if (terminalStatuses.has(status ?? "")) return "ack";
  if (!retryableGatedStatuses.has(status ?? "")) return undefined;
  return content?.includes(implementationTriggerMarker) ? "retry" : "ack";
}

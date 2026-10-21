export const implementationTriggerMarker = "[agentweave implementation-trigger]";

const retryableGatedStatuses = new Set([
  "paused",
  "waiting_for_human",
  "completing",
  "emergency_stopped",
]);

const terminalStatuses = new Set(["completed", "archived"]);

export function inboxStatusGateDecision(
  status: string | undefined,
  content: string | undefined,
): "ack" | "retry" | undefined {
  if (terminalStatuses.has(status ?? "")) return "ack";
  if (!retryableGatedStatuses.has(status ?? "")) return undefined;
  return content?.includes(implementationTriggerMarker) ? "retry" : "ack";
}

/**
 * Returns the durable claim identity for one delivery.
 * A business task may be handed to multiple agents (or intentionally re-driven
 * to the same agent), but a redelivery of one handoff must remain idempotent.
 */
export function executionKeyForDelivery(taskId: string | undefined, agentId: string, handoffKey: string): string {
  return taskId ? `${taskId}:${agentId}:${handoffKey}` : `${agentId}:${handoffKey}`;
}

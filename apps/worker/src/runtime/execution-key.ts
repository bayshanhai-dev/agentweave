/**
 * Returns the durable claim identity for one delivery.
 * A business task may be handed to multiple agents, but a redelivery to the
 * same agent must remain idempotent.
 */
export function executionKeyForDelivery(taskId: string | undefined, agentId: string, handoffKey: string): string {
  return taskId ? `${taskId}:${agentId}` : `${agentId}:${handoffKey}`;
}

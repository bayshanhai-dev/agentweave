export type RecoverableHumanMessage = {
  id: string;
  senderId: string;
  recipientIds: string[];
  deliveryStatus: string;
  taskId?: string;
  correlationId?: string;
};

export type HumanMessageBootRecoveryWorkstream = {
  id: string;
  status: string;
  agents: Array<{ id: string }>;
  messages: RecoverableHumanMessage[];
};

export type HumanMessageBootRecoverySummary = {
  scanned: number;
  redriven: number;
  redrivenWithExistingTask: number;
  skipped: number;
  skippedTriggerTraffic: number;
  skippedDispatchedTurn: number;
  skippedNoAgentRecipient: number;
  skippedDispatchFailed: number;
  ignoredNonHuman: number;
};

export type HumanMessageBootRecoveryDependencies = {
  hasExecutionClaim: (
    messageId: string,
    recipientId: string,
  ) => Promise<boolean>;
  dispatch: (
    message: RecoverableHumanMessage,
    recipientIds: string[],
  ) => Promise<boolean>;
  emit: (type: "message.dispatch_reconciled", message: string) => void;
};

const openDeliveryStatuses = new Set(["pending", "delivered"]);

export async function reconcilePendingHumanMessagesOnBoot(
  workstream: HumanMessageBootRecoveryWorkstream,
  dependencies: HumanMessageBootRecoveryDependencies,
): Promise<HumanMessageBootRecoverySummary> {
  const summary: HumanMessageBootRecoverySummary = {
    scanned: 0,
    redriven: 0,
    redrivenWithExistingTask: 0,
    skipped: 0,
    skippedTriggerTraffic: 0,
    skippedDispatchedTurn: 0,
    skippedNoAgentRecipient: 0,
    skippedDispatchFailed: 0,
    ignoredNonHuman: workstream.messages.filter(
      (message) =>
        message.senderId !== "human" &&
        openDeliveryStatuses.has(message.deliveryStatus),
    ).length,
  };

  if (workstream.status !== "active") return summary;

  const agentIds = new Set(workstream.agents.map((agent) => agent.id));
  const candidates = workstream.messages.filter(
    (message) =>
      message.senderId === "human" &&
      openDeliveryStatuses.has(message.deliveryStatus),
  );
  summary.scanned = candidates.length;

  for (const message of candidates) {
    if (message.correlationId?.startsWith("trigger:")) {
      summary.skipped += 1;
      summary.skippedTriggerTraffic += 1;
      continue;
    }
    const agentRecipients = message.recipientIds.filter((recipientId) =>
      agentIds.has(recipientId),
    );
    if (!agentRecipients.length) {
      summary.skipped += 1;
      summary.skippedNoAgentRecipient += 1;
      continue;
    }

    const claimed = await Promise.all(
      agentRecipients.map((recipientId) =>
        dependencies.hasExecutionClaim(message.id, recipientId),
      ),
    );
    const unclaimedRecipients = agentRecipients.filter(
      (_recipientId, index) => !claimed[index],
    );
    if (!unclaimedRecipients.length) {
      summary.skipped += 1;
      summary.skippedDispatchedTurn += 1;
      continue;
    }

    if (await dependencies.dispatch(message, unclaimedRecipients)) {
      summary.redriven += 1;
      if (message.taskId) summary.redrivenWithExistingTask += 1;
    } else {
      summary.skipped += 1;
      summary.skippedDispatchFailed += 1;
    }
  }

  dependencies.emit(
    "message.dispatch_reconciled",
    `Boot human-message recovery scanned ${summary.scanned}: re-driven ${summary.redriven} (reused existing task ${summary.redrivenWithExistingTask}); skipped ${summary.skipped} (trigger traffic ${summary.skippedTriggerTraffic}, dispatched turn ${summary.skippedDispatchedTurn}, no Agent recipient ${summary.skippedNoAgentRecipient}, dispatch failed ${summary.skippedDispatchFailed}); ignored out-of-scope non-Human messages ${summary.ignoredNonHuman}`,
  );
  return summary;
}

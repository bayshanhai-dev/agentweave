type ReconciliationAgent = { id: string; role: string };
type ReconciliationTask = {
  id: string;
  title: string;
  status: string;
  ownerAgentId?: string;
  createdByAgentId?: string;
  acceptanceCriteria: string[];
  dependencies: string[];
};
type ReconciliationMessage = {
  id: string;
  senderId: string;
  recipientIds: string[];
  messageType: string;
  taskId?: string;
  deliveryStatus: string;
};
type ReconciliationWorkstream = {
  id: string;
  status: string;
  agents: ReconciliationAgent[];
  tasks: ReconciliationTask[];
  messages: ReconciliationMessage[];
};
type ReconciliationPolicy = {
  templateId: string;
  leadRole: string;
  planningRole: string;
  executionRoles: readonly string[];
  reviewRole: string;
};
type DispatchReconciliationDependencies = {
  hasExecutionClaim: (taskId: string) => Promise<boolean>;
  dispatchTask: (input: {
    senderId: string;
    recipientId: string;
    content: string;
    taskId: string;
    causationId?: string;
  }) => Promise<{ deliveryStatus?: string }>;
  emit: (type: string, message: string, role?: string) => void;
};
type ReconciliationDependencies = DispatchReconciliationDependencies & {
  acknowledgeGateMessage: (message: ReconciliationMessage) => Promise<boolean>;
};

const openDeliveryStatuses = new Set(["pending", "delivered"]);
const terminalTaskStatuses = new Set(["done", "failed", "cancelled"]);

function taskDispatchContent(
  task: ReconciliationTask,
  owner: ReconciliationAgent,
  policy: ReconciliationPolicy,
): string {
  const phase =
    owner.role === policy.planningRole
      ? "planning"
      : owner.role === policy.reviewRole
        ? "review"
        : "execution";
  const marker = `[agentweave template=${policy.templateId} phase=${phase} recipient=${owner.role} lead=${policy.leadRole} planning=${policy.planningRole} execution=${policy.executionRoles[0] ?? policy.planningRole} review=${policy.reviewRole}]`;
  const criteria = task.acceptanceCriteria.length
    ? task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")
    : "- Task is completed with evidence";
  return `${marker}\nContinue the workstream after Human approval.\n\nPlanned task:\n${task.title}\n\nAcceptance criteria:\n${criteria}`;
}

/** Dispatch dependency-ready assigned tasks without duplicating durable work. */
export async function reconcileDispatchableTasks(
  workstream: ReconciliationWorkstream,
  policy: ReconciliationPolicy,
  dependencies: DispatchReconciliationDependencies,
  causationId?: string,
): Promise<string[]> {
  if (workstream.status !== "active") return [];

  const terminalTaskIds = new Set(
    workstream.tasks
      .filter((task) => terminalTaskStatuses.has(task.status))
      .map((task) => task.id),
  );
  const tasksWithOpenDeliveries = new Set(
    workstream.messages.flatMap((message) =>
      message.taskId && openDeliveryStatuses.has(message.deliveryStatus)
        ? [message.taskId]
        : [],
    ),
  );
  const lead = workstream.agents.find(
    (agent) => agent.role === policy.leadRole,
  );
  const dispatchedTaskIds: string[] = [];

  for (const task of workstream.tasks) {
    if (
      task.status !== "assigned" ||
      !task.ownerAgentId ||
      tasksWithOpenDeliveries.has(task.id) ||
      !task.dependencies.every((dependency) =>
        terminalTaskIds.has(dependency),
      ) ||
      (await dependencies.hasExecutionClaim(task.id))
    )
      continue;
    const owner = workstream.agents.find(
      (agent) => agent.id === task.ownerAgentId,
    );
    if (!owner) continue;
    const dispatched = await dependencies.dispatchTask({
      senderId: task.createdByAgentId ?? lead?.id ?? "human",
      recipientId: owner.id,
      content: taskDispatchContent(task, owner, policy),
      taskId: task.id,
      ...(causationId ? { causationId } : {}),
    });
    if (dispatched.deliveryStatus !== "delivered") continue;
    tasksWithOpenDeliveries.add(task.id);
    dispatchedTaskIds.push(task.id);
    dependencies.emit(
      "message.dispatch_reconciled",
      `Assigned task ${task.id} dispatched after dependency reconciliation`,
      owner.role,
    );
  }
  return dispatchedTaskIds;
}

/**
 * Releases a Human wave gate after the Workstream becomes active and restores
 * any dependency-ready assigned work that has no delivery or worker claim.
 */
export async function reconcileWaveGateAfterActivation(
  workstream: ReconciliationWorkstream,
  policy: ReconciliationPolicy,
  dependencies: ReconciliationDependencies,
): Promise<{ releasedGateMessageIds: string[]; dispatchedTaskIds: string[] }> {
  const result = {
    releasedGateMessageIds: [] as string[],
    dispatchedTaskIds: [] as string[],
  };
  if (workstream.status !== "active") return result;

  const heldDecisions = workstream.messages.filter(
    (message) =>
      message.messageType === "decision" &&
      message.deliveryStatus === "pending" &&
      message.recipientIds.includes("human"),
  );
  for (const message of heldDecisions) {
    if (!(await dependencies.acknowledgeGateMessage(message))) continue;
    result.releasedGateMessageIds.push(message.id);
    dependencies.emit(
      "message.gate_released",
      `Human gate decision ${message.id} was superseded by approval resume`,
      "human",
    );
  }

  const causationId = heldDecisions.at(-1)?.id;
  result.dispatchedTaskIds = await reconcileDispatchableTasks(
    workstream,
    policy,
    dependencies,
    causationId,
  );
  return result;
}

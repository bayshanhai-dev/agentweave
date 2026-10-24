import { durableTaskDeliveryStaleMs, executionClaimCutoffForTask } from "./dispatch-reliability.js";
import { isFinalValidationTask } from "./final-validation.js";

type ReconciliationAgent = { id: string; role: string; status?: string };
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
  createdAt?: string;
};
type ReconciliationWorkstream = {
  id: string;
  status: string;
  agents: ReconciliationAgent[];
  tasks: ReconciliationTask[];
  messages: ReconciliationMessage[];
  events?: Array<{ type: string; taskId?: string; occurredAt: string }>;
};
type ReconciliationPolicy = {
  templateId: string;
  leadRole: string;
  planningRole: string;
  executionRoles: readonly string[];
  reviewRole: string;
};
type DispatchReconciliationDependencies = {
  hasExecutionClaim: (taskId: string, startedAfter?: string) => Promise<boolean>;
  dispatchTask: (input: {
    senderId: string;
    recipientId: string;
    content: string;
    taskId: string;
    causationId?: string;
  }) => Promise<{ deliveryStatus?: string }>;
  emit: (type: string, message: string, role?: string) => void;
  inputsFromEarlierTasks?: (task: ReconciliationTask) => Promise<string>;
  /**
   * Marks a lost handoff's deliveries failed so the task can be dispatched
   * again. Optional: without it, stale deliveries are left untouched.
   */
  closeStaleDelivery?: (message: ReconciliationMessage) => Promise<boolean>;
  /** Injectable clock for staleness checks; defaults to Date.now. */
  now?: () => number;
  /** Staleness threshold override; defaults to durableTaskDeliveryStaleMs. */
  staleDeliveryMs?: number;
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
  dependencyInputs = "",
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
  const content = `${marker}\nContinue the workstream after Human approval.\n\nPlanned task:\n${task.title}\n\nAcceptance criteria:\n${criteria}`;
  return dependencyInputs ? `${content}\n\n${dependencyInputs}` : content;
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
  const openDeliveriesByTask = new Map<string, ReconciliationMessage[]>();
  for (const message of workstream.messages) {
    if (!message.taskId || !openDeliveryStatuses.has(message.deliveryStatus))
      continue;
    const existing = openDeliveriesByTask.get(message.taskId);
    if (existing) existing.push(message);
    else openDeliveriesByTask.set(message.taskId, [message]);
  }
  const lead = workstream.agents.find(
    (agent) => agent.role === policy.leadRole,
  );
  const dispatchedTaskIds: string[] = [];

  for (const task of workstream.tasks) {
    if (
      task.status !== "assigned" ||
      !task.ownerAgentId ||
      !task.dependencies.every((dependency) =>
        terminalTaskIds.has(dependency),
      ) ||
      // Final validation is a barrier task: it may only run once every other
      // durable task is terminal. Its explicit dependencies are fixed at
      // decomposition time, but review/continuation tasks created afterwards
      // must also finish first — otherwise a late completion proposal can
      // gate the Workstream while validation is still executing.
      (isFinalValidationTask(task) &&
        workstream.tasks.some(
          (other) =>
            other.id !== task.id && !terminalTaskStatuses.has(other.status),
        )) ||
      (await dependencies.hasExecutionClaim(
        task.id,
        executionClaimCutoffForTask(workstream.events, task.id),
      ))
    )
      continue;
    const owner = workstream.agents.find(
      (agent) => agent.id === task.ownerAgentId,
    );
    if (!owner) continue;
    const openDeliveries = openDeliveriesByTask.get(task.id) ?? [];
    if (openDeliveries.length > 0) {
      // A delivery exists. It is only safe to replace when it is provably
      // lost: every open handoff is older than the staleness threshold (the
      // watchdog cycle plus a re-drive window passed), the owning Agent is
      // idle (not merely busy with an earlier task in its queue), and no
      // execution claim exists (checked above). Anything else means the
      // handoff may still be picked up, so leave it alone.
      if (!dependencies.closeStaleDelivery) continue;
      const now = dependencies.now?.() ?? Date.now();
      const staleMs = dependencies.staleDeliveryMs ?? durableTaskDeliveryStaleMs;
      const newestDeliveryAt = Math.max(
        ...openDeliveries.map((message) => Date.parse(message.createdAt ?? "")),
      );
      if (!Number.isFinite(newestDeliveryAt) || now - newestDeliveryAt < staleMs)
        continue;
      if (owner.status && owner.status !== "idle") continue;
      let closedAll = true;
      for (const message of openDeliveries) {
        if (!(await dependencies.closeStaleDelivery(message))) {
          closedAll = false;
          break;
        }
      }
      if (!closedAll) continue;
      dependencies.emit(
        "message.dispatch_reconciled",
        `Stale handoff for task ${task.id} closed; dispatching a fresh handoff`,
        owner.role,
      );
    }
    const dependencyInputs = await dependencies.inputsFromEarlierTasks?.(task);
    const dispatched = await dependencies.dispatchTask({
      senderId: task.createdByAgentId ?? lead?.id ?? "human",
      recipientId: owner.id,
      content: taskDispatchContent(task, owner, policy, dependencyInputs),
      taskId: task.id,
      ...(causationId ? { causationId } : {}),
    });
    if (dispatched.deliveryStatus !== "delivered") continue;
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

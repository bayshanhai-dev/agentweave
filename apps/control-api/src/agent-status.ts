import { canAgentTransition, type AgentStatus } from "@agentweave/domain";

export type AgentStatusAgent = { id: string; status: AgentStatus };

export type AgentStatusTransitionContext = {
  reason: string;
  taskId?: string;
  turnId?: string;
  actor?: string;
};

export type AgentStatusEventPayload = {
  from: AgentStatus;
  to: AgentStatus;
  reason: string;
  taskId?: string;
  turnId?: string;
};

export type AgentStatusEvent = {
  type: "agent.status_changed" | "agent.transition_rejected";
  agentId: string;
  payload: AgentStatusEventPayload;
};

export type AgentStatusTransitionResult = {
  from: AgentStatus;
  to: AgentStatus;
  valid: boolean;
  applied: boolean;
  rejected: boolean;
};

export type AgentStatusTransitionDependencies = {
  persist: (agentId: string, status: AgentStatus) => Promise<void>;
  emit?: (event: AgentStatusEvent) => Promise<void> | void;
  onApplied?: (from: AgentStatus, to: AgentStatus) => void;
  onRejected?: (from: AgentStatus, to: AgentStatus) => void;
  enforce?: boolean;
};

const enforcementEnabled = () => process.env.AGENT_FSM_ENFORCE === "true";

const contextPayload = (from: AgentStatus, to: AgentStatus, context: AgentStatusTransitionContext) => ({
  from,
  to,
  reason: context.reason,
  ...(context.taskId ? { taskId: context.taskId } : {}),
  ...(context.turnId ? { turnId: context.turnId } : {}),
});

/**
 * The only status transition entry point. Observe mode records an invalid
 * request and preserves the legacy write; enforcement can be enabled later.
 */
export async function transitionAgentStatus(
  agent: AgentStatusAgent,
  to: AgentStatus,
  context: AgentStatusTransitionContext,
  dependencies: AgentStatusTransitionDependencies = { persist: async () => undefined },
): Promise<AgentStatusTransitionResult> {
  const from = agent.status;
  if (from === to)
    return { from, to, valid: true, applied: false, rejected: false };

  const valid = canAgentTransition(from, to);
  const rejected = !valid;
  const rejectionEvent: AgentStatusEvent = {
    type: "agent.transition_rejected",
    agentId: agent.id,
    payload: { from, to, reason: context.reason },
  };

  if (rejected) {
    try { dependencies.onRejected?.(from, to); } catch { /* metrics are best effort */ }
    try { await dependencies.emit?.(rejectionEvent); } catch { /* audit is best effort */ }
    if (dependencies.enforce ?? enforcementEnabled())
      return { from, to, valid, applied: false, rejected: true };
  }

  try {
    await dependencies.persist(agent.id, to);
    agent.status = to;
    const statusEvent: AgentStatusEvent = {
      type: "agent.status_changed",
      agentId: agent.id,
      payload: contextPayload(from, to, context),
    };
    try { await dependencies.emit?.(statusEvent); } catch { /* audit is best effort */ }
    try { dependencies.onApplied?.(from, to); } catch { /* metrics are best effort */ }
    return { from, to, valid, applied: true, rejected };
  } catch {
    // Status writes are deliberately best-effort side effects at all current call sites.
    return { from, to, valid, applied: false, rejected };
  }
}

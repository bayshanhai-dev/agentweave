export type PersistedAgent = {
  id: string;
  role: string;
  authority: string;
  status: string;
};

export type PersistedWorkstream = {
  id: string;
  goal: string;
  flavor: string;
  status: string;
  provider: { tool: string; model: string };
  workspaceRoot: string;
  agents: PersistedAgent[];
};

export type PersistedTask = {
  id: string;
  workstreamId: string;
  title: string;
  status: string;
  ownerAgentId?: string;
  createdByAgentId?: string;
  parentTaskId?: string;
  relatedTaskIds: string[];
  acceptanceCriteria: string[];
  dependencies: string[];
  evidence: string[];
  createdAt: string;
  updatedAt: string;
};

export type PersistedMessage = {
  id: string;
  workstreamId: string;
  senderId: string;
  recipientIds: string[];
  messageType: string;
  content: string;
  taskId?: string;
  correlationId: string;
  causationId?: string;
  evidenceIds: string[];
  createdAt: string;
  deliveryStatus: string;
};

export type PersistedWorkflowEvent = {
  id: string;
  type: string;
  message: string;
  role?: string;
  from?: string;
  to?: string;
  agentId?: string;
  taskId?: string;
  correlationId?: string;
  provider?: string;
  model?: string;
  usage?: unknown;
  occurredAt: string;
};

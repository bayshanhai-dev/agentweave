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
  provider: ProviderSelection;
  roleProviders: RoleProviders;
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
  qualityAttempts?: number;
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
  sequence?: number;
  type: string;
  message: string;
  role?: string;
  from?: string;
  to?: string;
  agentId?: string;
  taskId?: string;
  toolName?: string;
  output?: string;
  correlationId?: string;
  provider?: string;
  model?: string;
  usage?: unknown;
  occurredAt: string;
};
import type { ProviderSelection, RoleProviders } from "@agentweave/protocol";

import type { ProviderSession, SessionCheckpoint } from "./types.js";

export type AgentSessionRecord = {
  id: string; agentId: string; provider: string; providerSessionId: string;
  status: ProviderSession["status"]; currentTurnId?: string;
  lastCheckpoint?: SessionCheckpoint; lastEventSequence: number;
  workerId?: string; leaseExpiresAt?: string; updatedAt: string;
};

/** Database integration point. Stores runtime state, not provider-specific payloads. */
export interface AgentSessionRepository {
  listUnfinished(workerId?: string): Promise<AgentSessionRecord[]>;
  save(record: AgentSessionRecord): Promise<void>;
  acquireLease(id: string, workerId: string, leaseExpiresAt: string): Promise<boolean>;
  releaseLease(id: string, workerId: string): Promise<void>;
  claimTask(taskId: string, workstreamId: string | undefined, workerId: string, messageId: string, leaseExpiresAt: string): Promise<boolean>;
  finishTask(taskId: string, status: "completed" | "failed"): Promise<void>;
}

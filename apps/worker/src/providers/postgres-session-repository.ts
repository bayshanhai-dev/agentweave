import postgres, { type Sql } from "postgres";
import type { AgentSessionRecord, AgentSessionRepository } from "./session-repository.js";

export class PostgresAgentSessionRepository implements AgentSessionRepository {
  constructor(private readonly sql: Sql = postgres(process.env.DATABASE_URL ?? "postgres://agentweave:agentweave@localhost:5432/agentweave")) {}
  async listUnfinished(workerId?: string): Promise<AgentSessionRecord[]> {
    const rows = await this.sql`select * from agent_sessions where status = 'active' and (lease_expires_at is null or lease_expires_at < now()) ${workerId ? this.sql`and (worker_id is null or worker_id = ${workerId})` : this.sql``} order by updated_at asc`;
    return rows as unknown as AgentSessionRecord[];
  }
  async save(record: AgentSessionRecord): Promise<void> {
    await this.sql`insert into agent_sessions (id, agent_id, provider, provider_session_id, status, current_turn_id, last_checkpoint, last_event_sequence, worker_id, lease_expires_at, updated_at) values (${record.id}, ${record.agentId}, ${record.provider}, ${record.providerSessionId}, ${record.status}, ${record.currentTurnId ?? null}, ${record.lastCheckpoint ? JSON.stringify(record.lastCheckpoint) : null}, ${record.lastEventSequence}, ${record.workerId ?? null}, ${record.leaseExpiresAt ?? null}, ${record.updatedAt}) on conflict (id) do update set agent_id=excluded.agent_id, provider=excluded.provider, provider_session_id=excluded.provider_session_id, status=excluded.status, current_turn_id=excluded.current_turn_id, last_checkpoint=excluded.last_checkpoint, last_event_sequence=excluded.last_event_sequence, worker_id=excluded.worker_id, lease_expires_at=excluded.lease_expires_at, updated_at=excluded.updated_at`;
  }
  async acquireLease(id: string, workerId: string, leaseExpiresAt: string): Promise<boolean> {
    const rows = await this.sql`update agent_sessions set worker_id=${workerId}, lease_expires_at=${leaseExpiresAt}, updated_at=now() where id=${id} and status='active' and (lease_expires_at is null or lease_expires_at < now() or worker_id=${workerId}) returning id`;
    return rows.length === 1;
  }
  async releaseLease(id: string, workerId: string): Promise<void> { await this.sql`update agent_sessions set worker_id=null, lease_expires_at=null, updated_at=now() where id=${id} and worker_id=${workerId}`; }
  async claimTask(taskId: string, workstreamId: string | undefined, workerId: string, messageId: string, leaseExpiresAt: string): Promise<boolean> {
    const rows = await this.sql`
      insert into task_execution_claims (task_id, workstream_id, worker_id, message_id, status, lease_expires_at)
      values (${taskId}, ${workstreamId ?? null}, ${workerId}, ${messageId}, 'active', ${leaseExpiresAt})
      on conflict (task_id) do update set worker_id=excluded.worker_id, message_id=excluded.message_id, status='active', lease_expires_at=excluded.lease_expires_at, started_at=now(), finished_at=null
      where task_execution_claims.status = 'active' and task_execution_claims.lease_expires_at < now()
      returning task_id`;
    return rows.length === 1;
  }
  async finishTask(taskId: string, status: "completed" | "failed"): Promise<void> {
    await this.sql`update task_execution_claims set status=${status}, finished_at=now(), lease_expires_at=null where task_id=${taskId} and status='active'`;
  }
}

import postgres, { type Sql } from "postgres";
import type { AgentSessionRecord, AgentSessionRepository } from "./session-repository.js";

export class PostgresAgentSessionRepository implements AgentSessionRepository {
  constructor(private readonly sql: Sql = postgres(process.env.DATABASE_URL ?? "postgres://agentweave:agentweave@localhost:5432/agentweave")) {}
  async listUnfinished(workerId?: string): Promise<AgentSessionRecord[]> {
    const rows = await this.sql`select * from agent_sessions where status = 'active' and (lease_expires_at is null or lease_expires_at < now()) ${workerId ? this.sql`and (worker_id is null or worker_id = ${workerId})` : this.sql``} order by updated_at asc`;
    return rows as unknown as AgentSessionRecord[];
  }
  async save(record: AgentSessionRecord): Promise<void> {
    await this.sql`insert into agent_sessions ${this.sql(record)} on conflict (id) do update set agent_id=excluded.agent_id, provider=excluded.provider, provider_session_id=excluded.provider_session_id, status=excluded.status, current_turn_id=excluded.current_turn_id, last_checkpoint=excluded.last_checkpoint, last_event_sequence=excluded.last_event_sequence, worker_id=excluded.worker_id, lease_expires_at=excluded.lease_expires_at, updated_at=excluded.updated_at`;
  }
  async acquireLease(id: string, workerId: string, leaseExpiresAt: string): Promise<boolean> {
    const rows = await this.sql`update agent_sessions set worker_id=${workerId}, lease_expires_at=${leaseExpiresAt}, updated_at=now() where id=${id} and status='active' and (lease_expires_at is null or lease_expires_at < now() or worker_id=${workerId}) returning id`;
    return rows.length === 1;
  }
  async releaseLease(id: string, workerId: string): Promise<void> { await this.sql`update agent_sessions set worker_id=null, lease_expires_at=null, updated_at=now() where id=${id} and worker_id=${workerId}`; }
}

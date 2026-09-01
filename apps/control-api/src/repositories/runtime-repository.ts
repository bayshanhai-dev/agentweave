import type { Sql } from "postgres";

export class RuntimeRepository {
  constructor(private readonly sql: Sql) {}

  async registerWorker(input: {
    workerId: string;
    provider: string;
    providerModel: string;
    endpoint?: string | null;
    roles: string[];
    capabilities: string[];
  }): Promise<void> {
    await this
      .sql`insert into runtime_workers (id, provider, provider_model, endpoint, roles, capabilities, status, last_heartbeat_at) values (${input.workerId}, ${input.provider}, ${input.providerModel}, ${input.endpoint ?? null}, ${input.roles}, ${input.capabilities}, 'online', now()) on conflict (id) do update set provider=excluded.provider, provider_model=excluded.provider_model, endpoint=excluded.endpoint, roles=excluded.roles, capabilities=excluded.capabilities, status='online', last_heartbeat_at=now()`;
  }

  async heartbeatWorker(workerId: string, taskId?: string): Promise<boolean> {
    const rows = await this
      .sql`update runtime_workers set status='online', last_heartbeat_at=now(), current_task_id=${taskId ?? null} where id=${workerId} returning id`;
    return rows.length > 0;
  }

  async claimEvent(
    id: string,
    workstreamId: string,
    eventType: string,
  ): Promise<boolean> {
    const rows = await this
      .sql`insert into consumed_runtime_events (id, workstream_id, event_type) values (${id}, ${workstreamId}, ${eventType}) on conflict do nothing returning id`;
    return rows.length > 0;
  }

  async releaseEvent(id: string): Promise<void> {
    await this.sql`delete from consumed_runtime_events where id = ${id}`;
  }
  async markStaleWorkersOffline(): Promise<void> {
    await this
      .sql`update runtime_workers set status='offline', updated_at=now() where status='online' and last_heartbeat_at < now() - interval '45 seconds'`;
  }
}

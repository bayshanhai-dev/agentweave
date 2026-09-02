import type { Sql } from "postgres";
import type { PersistedWorkflowEvent } from "./types.js";

export class WorkflowEventRepository {
  constructor(private readonly sql: Sql) {}

  async append(
    workstreamId: string,
    event: PersistedWorkflowEvent,
  ): Promise<number> {
    return this.sql.begin(async (transaction) => {
      await transaction`select id from workstreams where id = ${workstreamId} for update`;
      const next = event.sequence ?? Number((await transaction`select coalesce(max(sequence), 0) + 1 as sequence from workflow_events where workstream_id = ${workstreamId}`)[0]?.sequence ?? 1);
      const inserted = await transaction`insert into workflow_events (id, workstream_id, sequence, type, message, role, from_node, to_node, agent_id, task_id, correlation_id, provider, model, usage, occurred_at)
        values (${event.id}, ${workstreamId}, ${next}, ${event.type}, ${event.message}, ${event.role ?? null}, ${event.from ?? null}, ${event.to ?? null}, ${event.agentId ?? null}, ${event.taskId ?? null}, ${event.correlationId ?? null}, ${event.provider ?? null}, ${event.model ?? null}, ${event.usage ? JSON.stringify(event.usage) : null}, ${event.occurredAt})
        on conflict (id) do update set id = excluded.id returning sequence`;
      return Number(inserted[0]?.sequence ?? next);
    });
  }

  async listRows(workstreamId: string) {
    return this
      .sql`select id, sequence, type, message, role, from_node, to_node, agent_id, task_id, correlation_id, provider, model, usage, occurred_at from workflow_events where workstream_id = ${workstreamId} order by sequence asc`;
  }

  async listAfter(workstreamId: string, sequence: number) {
    return this.sql`select id, sequence, type, message, role, from_node, to_node, agent_id, task_id, correlation_id, provider, model, usage, occurred_at from workflow_events where workstream_id = ${workstreamId} and sequence > ${sequence} order by sequence asc`;
  }

  async getCheckpoint(projector: string, workstreamId: string): Promise<number> {
    const rows = await this.sql`select last_sequence from projector_checkpoints where projector = ${projector} and workstream_id = ${workstreamId}`;
    return Number(rows[0]?.last_sequence ?? 0);
  }

  async saveCheckpoint(projector: string, workstreamId: string, sequence: number): Promise<void> {
    await this.sql`insert into projector_checkpoints (projector, workstream_id, last_sequence) values (${projector}, ${workstreamId}, ${sequence}) on conflict (projector, workstream_id) do update set last_sequence = greatest(projector_checkpoints.last_sequence, excluded.last_sequence), updated_at = now()`;
  }
}

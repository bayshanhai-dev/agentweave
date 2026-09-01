import type { Sql } from "postgres";
import type { PersistedWorkflowEvent } from "./types.js";

export class WorkflowEventRepository {
  constructor(private readonly sql: Sql) {}

  async append(
    workstreamId: string,
    event: PersistedWorkflowEvent,
  ): Promise<void> {
    await this
      .sql`insert into workflow_events (id, workstream_id, type, message, role, from_node, to_node, agent_id, task_id, correlation_id, provider, model, usage, occurred_at)
      values (${event.id}, ${workstreamId}, ${event.type}, ${event.message}, ${event.role ?? null}, ${event.from ?? null}, ${event.to ?? null}, ${event.agentId ?? null}, ${event.taskId ?? null}, ${event.correlationId ?? null}, ${event.provider ?? null}, ${event.model ?? null}, ${event.usage ? JSON.stringify(event.usage) : null}, ${event.occurredAt})`;
  }

  async listRows(workstreamId: string) {
    return this
      .sql`select id, type, message, role, from_node, to_node, agent_id, task_id, correlation_id, provider, model, usage, occurred_at from workflow_events where workstream_id = ${workstreamId} order by occurred_at asc`;
  }
}

import type { Sql } from "postgres";
import type { PersistedTask } from "./types.js";

export class TaskRepository {
  constructor(private readonly sql: Sql) {}

  async save(task: PersistedTask): Promise<void> {
    await this
      .sql`insert into tasks (id, workstream_id, title, status, owner_agent_id, created_by_agent_id, parent_task_id, related_task_ids, acceptance_criteria, dependencies, evidence, created_at, updated_at)
      values (${task.id}, ${task.workstreamId}, ${task.title}, ${task.status}, ${task.ownerAgentId ?? null}, ${task.createdByAgentId ?? null}, ${task.parentTaskId ?? null}, ${JSON.stringify(task.relatedTaskIds)}, ${JSON.stringify(task.acceptanceCriteria)}, ${JSON.stringify(task.dependencies)}, ${JSON.stringify(task.evidence)}, ${task.createdAt}, ${task.updatedAt})
      on conflict (id) do update set status = excluded.status, owner_agent_id = excluded.owner_agent_id, created_by_agent_id = excluded.created_by_agent_id, parent_task_id = excluded.parent_task_id, related_task_ids = excluded.related_task_ids, acceptance_criteria = excluded.acceptance_criteria, dependencies = excluded.dependencies, evidence = excluded.evidence, updated_at = excluded.updated_at`;
  }

  async listRows(workstreamId: string) {
    return this
      .sql`select id, workstream_id, title, status, owner_agent_id, created_by_agent_id, parent_task_id, related_task_ids, acceptance_criteria, dependencies, evidence, created_at, updated_at from tasks where workstream_id = ${workstreamId} order by created_at asc`;
  }
}

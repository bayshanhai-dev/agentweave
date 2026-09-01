import type { Sql } from "postgres";

export class EvidenceRepository {
  constructor(private readonly sql: Sql) {}
  async countMatching(taskId: string, evidenceIds: string[]): Promise<number> {
    if (!evidenceIds.length) return 0;
    const rows = await this
      .sql`select id from workspace_evidence where task_id = ${taskId} and id = any(${evidenceIds}::bigint[])`;
    return rows.length;
  }
}

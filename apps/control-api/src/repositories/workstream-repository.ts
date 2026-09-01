import type { Sql } from "postgres";
import type { PersistedWorkstream } from "./types.js";

export class WorkstreamRepository {
  constructor(private readonly sql: Sql) {}

  async create(workstream: PersistedWorkstream): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`insert into workstreams (id, goal, flavor, status, tool, model, workspace_root)
        values (${workstream.id}, ${workstream.goal}, ${workstream.flavor}, ${workstream.status}, ${workstream.provider.tool}, ${workstream.provider.model}, ${workstream.workspaceRoot})`;
      for (const agent of workstream.agents) {
        await transaction`insert into agents (id, workstream_id, role, authority, status)
          values (${agent.id}, ${workstream.id}, ${agent.role}, ${agent.authority}, ${agent.status})`;
      }
    });
  }

  async saveState(
    workstream: Pick<PersistedWorkstream, "id" | "status" | "agents">,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`update workstreams set status = ${workstream.status}, updated_at = now() where id = ${workstream.id}`;
      for (const agent of workstream.agents)
        await transaction`update agents set status = ${agent.status} where id = ${agent.id}`;
    });
  }

  async saveAgentStatus(agentId: string, status: string): Promise<void> {
    await this.sql`update agents set status = ${status} where id = ${agentId}`;
  }

  async updateStatus(workstreamId: string, status: string): Promise<void> {
    await this
      .sql`update workstreams set status = ${status}, updated_at = now() where id = ${workstreamId}`;
  }

  async listRows() {
    return this
      .sql`select id, goal, flavor, status, tool, model, workspace_root from workstreams order by created_at desc`;
  }
  async listAgentRows(workstreamId: string) {
    return this
      .sql`select id, role, authority, status from agents where workstream_id = ${workstreamId} order by id`;
  }
}

import type { Sql } from "postgres";
import type { AgentStatus } from "@agentweave/domain";

type AgentStatusUpdate = { id: string; status: AgentStatus };

export class WorkstreamCommandRepository {
  constructor(private readonly sql: Sql) {}

  async findResponse<T>(workstreamId: string, commandId: string): Promise<T | undefined> {
    const rows = await this.sql`
      select response
      from workstream_commands
      where workstream_id = ${workstreamId} and command_id = ${commandId}
    `;
    return rows[0]?.response as T | undefined;
  }

  async commit(input: {
    workstreamId: string;
    commandId: string;
    command: string;
    status: string;
    agents: AgentStatusUpdate[];
    response: unknown;
  }): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`
        update workstreams
        set status = ${input.status}, updated_at = now()
        where id = ${input.workstreamId}
      `;
      // Agent rows are persisted by transitionAgentStatus before this command
      // receipt is committed. Keeping this boundary focused on the workstream
      // and idempotency receipt prevents a second unguarded status writer.
      await transaction`
        insert into workstream_commands (workstream_id, command_id, command, response)
        values (${input.workstreamId}, ${input.commandId}, ${input.command}, ${JSON.stringify(input.response)})
      `;
    });
  }
}

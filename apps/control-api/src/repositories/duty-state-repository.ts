import type { Sql } from "postgres";

export type DutyStateEntry = {
  stateKey: string;
  state: Record<string, unknown>;
  updatedAt: string;
};

function stateObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mapEntry(row: Record<string, unknown>): DutyStateEntry {
  return {
    stateKey: String(row.state_key),
    state: stateObject(row.state),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export class DutyStateRepository {
  constructor(private readonly sql: Sql) {}

  async get(
    workstreamId: string,
    key: string,
  ): Promise<DutyStateEntry | undefined> {
    const rows = await this
      .sql`select state_key, state, updated_at from duty_state where workstream_id = ${workstreamId} and state_key = ${key}`;
    return rows[0] ? mapEntry(rows[0]) : undefined;
  }

  async upsert(
    workstreamId: string,
    key: string,
    state: Record<string, unknown>,
  ): Promise<DutyStateEntry> {
    const rows = await this
      .sql`insert into duty_state (workstream_id, state_key, state)
      values (${workstreamId}, ${key}, ${JSON.stringify(state)}::jsonb)
      on conflict (workstream_id, state_key) do update
      set state = excluded.state, updated_at = now()
      returning state_key, state, updated_at`;
    return mapEntry(rows[0]!);
  }

  async listByWorkstream(workstreamId: string): Promise<DutyStateEntry[]> {
    const rows = await this
      .sql`select state_key, state, updated_at from duty_state where workstream_id = ${workstreamId} order by state_key asc`;
    return rows.map(mapEntry);
  }
}

import type { WorkstreamTemplate } from "@agentweave/domain";
import type { Sql } from "postgres";

const fromRow = (row: Record<string, unknown>): WorkstreamTemplate =>
  row.template as WorkstreamTemplate;

export class TemplateRepository {
  constructor(private readonly sql: Sql) {}

  async listCustom(): Promise<WorkstreamTemplate[]> {
    const rows = await this.sql`select template from custom_workstream_templates order by created_at asc`;
    return rows.map((row) => fromRow(row as Record<string, unknown>));
  }

  async saveCustom(template: WorkstreamTemplate): Promise<void> {
    await this.sql`insert into custom_workstream_templates (id, template) values (${template.id}, ${JSON.stringify(template)}::jsonb)`;
  }

  async deleteCustom(id: string): Promise<boolean> {
    const rows = await this.sql`delete from custom_workstream_templates where id = ${id} returning id`;
    return rows.length > 0;
  }
}

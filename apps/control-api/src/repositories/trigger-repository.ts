import type { Sql } from "postgres";
import type {
  Trigger,
  TriggerFire,
  TriggerFireStatus,
} from "../trigger-scheduler.js";

type TriggerRow = Record<string, unknown>;

function iso(value: unknown): string | undefined {
  return value ? new Date(String(value)).toISOString() : undefined;
}

function mapTrigger(row: TriggerRow): Trigger {
  return {
    id: String(row.id),
    name: String(row.name),
    enabled: Boolean(row.enabled),
    kind: String(row.kind) as Trigger["kind"],
    ...(row.cron_expr ? { cronExpr: String(row.cron_expr) } : {}),
    timezone: String(row.timezone),
    targetMode: String(row.target_mode) as Trigger["targetMode"],
    ...(row.target_workstream_id
      ? { targetWorkstreamId: String(row.target_workstream_id) }
      : {}),
    ...(row.template_id ? { templateId: String(row.template_id) } : {}),
    ...(row.goal_template !== null && row.goal_template !== undefined
      ? { goalTemplate: String(row.goal_template) }
      : {}),
    dutyTitle: String(row.duty_title),
    dutyPrompt: String(row.duty_prompt),
    ...(row.state_key ? { stateKey: String(row.state_key) } : {}),
    priority: Number(row.priority),
    ...(row.max_runs_per_day !== null && row.max_runs_per_day !== undefined
      ? { maxRunsPerDay: Number(row.max_runs_per_day) }
      : {}),
    ...(row.quiet_start ? { quietStart: String(row.quiet_start) } : {}),
    ...(row.quiet_end ? { quietEnd: String(row.quiet_end) } : {}),
    batchWindowSec: Number(row.batch_window_sec),
    overlapPolicy: String(row.overlap_policy) as Trigger["overlapPolicy"],
    ...(iso(row.last_fired_at) ? { lastFiredAt: iso(row.last_fired_at)! } : {}),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function mapFire(row: TriggerRow): TriggerFire {
  return {
    id: String(row.id),
    triggerId: String(row.trigger_id),
    slotKey: String(row.slot_key),
    status: String(row.status) as TriggerFireStatus,
    ...(row.reason ? { reason: String(row.reason) } : {}),
    ...(row.workstream_id ? { workstreamId: String(row.workstream_id) } : {}),
    ...(row.message_id ? { messageId: String(row.message_id) } : {}),
    ...(row.duty_task_id ? { dutyTaskId: String(row.duty_task_id) } : {}),
    firedAt: iso(row.fired_at)!,
  };
}

export class TriggerRepository {
  constructor(private readonly sql: Sql) {}

  async list(): Promise<Trigger[]> {
    const rows = await this
      .sql`select * from triggers order by priority desc, name asc`;
    return rows.map(mapTrigger);
  }

  async listEnabled(): Promise<Trigger[]> {
    const rows = await this
      .sql`select * from triggers where enabled = true order by priority desc, name asc`;
    return rows.map(mapTrigger);
  }

  async find(id: string): Promise<Trigger | undefined> {
    const rows = await this.sql`select * from triggers where id = ${id}`;
    return rows[0] ? mapTrigger(rows[0]) : undefined;
  }

  async create(trigger: Trigger): Promise<Trigger> {
    const rows = await this.sql`insert into triggers
      (id, name, enabled, kind, cron_expr, timezone, target_mode, target_workstream_id, template_id, goal_template, duty_title, duty_prompt, state_key, priority, max_runs_per_day, quiet_start, quiet_end, batch_window_sec, overlap_policy)
      values (${trigger.id}, ${trigger.name}, ${trigger.enabled}, ${trigger.kind}, ${trigger.cronExpr ?? null}, ${trigger.timezone}, ${trigger.targetMode}, ${trigger.targetWorkstreamId ?? null}, ${trigger.templateId ?? null}, ${trigger.goalTemplate ?? null}, ${trigger.dutyTitle}, ${trigger.dutyPrompt}, ${trigger.stateKey ?? null}, ${trigger.priority}, ${trigger.maxRunsPerDay ?? null}, ${trigger.quietStart ?? null}, ${trigger.quietEnd ?? null}, ${trigger.batchWindowSec}, ${trigger.overlapPolicy}) returning *`;
    return mapTrigger(rows[0]!);
  }

  async update(id: string, trigger: Trigger): Promise<Trigger | undefined> {
    const rows = await this.sql`update triggers set
      name = ${trigger.name}, enabled = ${trigger.enabled}, kind = ${trigger.kind}, cron_expr = ${trigger.cronExpr ?? null}, timezone = ${trigger.timezone}, target_mode = ${trigger.targetMode}, target_workstream_id = ${trigger.targetWorkstreamId ?? null}, template_id = ${trigger.templateId ?? null}, goal_template = ${trigger.goalTemplate ?? null}, duty_title = ${trigger.dutyTitle}, duty_prompt = ${trigger.dutyPrompt}, state_key = ${trigger.stateKey ?? null}, priority = ${trigger.priority}, max_runs_per_day = ${trigger.maxRunsPerDay ?? null}, quiet_start = ${trigger.quietStart ?? null}, quiet_end = ${trigger.quietEnd ?? null}, batch_window_sec = ${trigger.batchWindowSec}, overlap_policy = ${trigger.overlapPolicy}, updated_at = now()
      where id = ${id} returning *`;
    return rows[0] ? mapTrigger(rows[0]) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this
      .sql`delete from triggers where id = ${id} returning id`;
    return rows.length > 0;
  }

  async listFiresSince(since: Date): Promise<TriggerFire[]> {
    const rows = await this
      .sql`select * from trigger_fires where fired_at >= ${since.toISOString()} order by fired_at asc`;
    return rows.map(mapFire);
  }

  async findFire(
    triggerId: string,
    slotKey: string,
  ): Promise<TriggerFire | undefined> {
    const rows = await this
      .sql`select * from trigger_fires where trigger_id = ${triggerId} and slot_key = ${slotKey}`;
    return rows[0] ? mapFire(rows[0]) : undefined;
  }

  async insertFire(fire: TriggerFire): Promise<boolean> {
    const rows = await this
      .sql`insert into trigger_fires (id, trigger_id, slot_key, status, reason, workstream_id, message_id, duty_task_id, fired_at)
      values (${fire.id}, ${fire.triggerId}, ${fire.slotKey}, ${fire.status}, ${fire.reason ?? null}, ${fire.workstreamId ?? null}, ${fire.messageId ?? null}, ${fire.dutyTaskId ?? null}, ${fire.firedAt})
      on conflict (trigger_id, slot_key) do nothing returning id`;
    return rows.length > 0;
  }

  async updateFire(
    id: string,
    update: {
      status: TriggerFireStatus;
      reason?: string;
      workstreamId?: string;
      messageId?: string;
      dutyTaskId?: string;
    },
  ): Promise<void> {
    await this
      .sql`update trigger_fires set status = ${update.status}, reason = ${update.reason ?? null}, workstream_id = ${update.workstreamId ?? null}, message_id = ${update.messageId ?? null}, duty_task_id = ${update.dutyTaskId ?? null} where id = ${id}`;
  }

  async updateLastFiredAt(id: string, firedAt: string): Promise<void> {
    await this
      .sql`update triggers set last_fired_at = ${firedAt}, updated_at = now() where id = ${id}`;
  }

  async findLatestBatchFire(
    triggerId: string,
    since: Date,
  ): Promise<TriggerFire | undefined> {
    const rows = await this
      .sql`select * from trigger_fires where trigger_id = ${triggerId} and status = 'fired' and fired_at >= ${since.toISOString()} order by fired_at desc limit 1`;
    return rows[0] ? mapFire(rows[0]) : undefined;
  }

  async hasOpenOverlap(trigger: Trigger): Promise<boolean> {
    if (trigger.targetMode === "workstream") {
      const rows = await this.sql`select 1
        from trigger_fires f
        join messages m on m.id = f.message_id and m.correlation_id like ${`trigger:${trigger.id}:%`}
        join tasks t on t.id = m.task_id
        where f.trigger_id = ${trigger.id} and f.status = 'fired'
          and t.status not in ('done', 'cancelled', 'failed')
        limit 1`;
      return rows.length > 0;
    }
    const rows = await this.sql`select 1
      from trigger_fires f join workstreams w on w.id = f.workstream_id
      where f.trigger_id = ${trigger.id} and f.status = 'fired'
        and w.status not in ('completed', 'cancelled', 'failed', 'emergency_stopped', 'archived')
      limit 1`;
    return rows.length > 0;
  }

  async findDutyContextByTaskId(taskId: string): Promise<
    { triggerId: string; workstreamId: string; stateKey: string } | undefined
  > {
    const rows = await this.sql`select f.trigger_id, f.workstream_id,
        coalesce(t.state_key, t.name) as state_key
      from trigger_fires f
      join triggers t on t.id = f.trigger_id
      where f.duty_task_id = ${taskId} and f.status = 'fired'
        and f.workstream_id is not null
      order by f.fired_at desc
      limit 1`;
    const row = rows[0];
    return row
      ? {
          triggerId: String(row.trigger_id),
          workstreamId: String(row.workstream_id),
          stateKey: String(row.state_key),
        }
      : undefined;
  }
}

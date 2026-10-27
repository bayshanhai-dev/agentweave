import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrations.js";
import { collectObservabilityMetrics } from "../src/observability-metrics.js";

const databaseUrl = process.env.OBSERVABILITY_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("observability metrics PostgreSQL schema", () => {
  const sql = postgres(databaseUrl ?? "postgres://unused", { max: 4 });
  const fixtureId = `observability-test-${randomUUID()}`;
  const workstreamId = `${fixtureId}-workstream`;
  const taskId = `${fixtureId}-task`;
  const triggerId = `${fixtureId}-trigger`;
  const fireId = `${fixtureId}-fire`;
  const messageId = `${fixtureId}-message`;
  const correlationId = `${fixtureId}-correlation`;
  const startedEventId = `${fixtureId}-started`;
  const completedEventId = `${fixtureId}-completed`;
  const pendingOutboxId = `${fixtureId}-outbox-pending`;
  const deliveredOutboxId = `${fixtureId}-outbox-delivered`;

  const createEventOutbox = () => sql`
    create table if not exists event_outbox (
      id text primary key,
      workstream_id text,
      subject text,
      envelope jsonb,
      status text not null,
      attempts integer not null default 0,
      available_at timestamptz,
      locked_at timestamptz,
      delivered_at timestamptz,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`;

  beforeAll(async () => {
    await runMigrations(sql);
    await createEventOutbox();
    await sql`alter table trigger_fires add column if not exists duty_task_id text`;

    const now = new Date();
    const recentStart = new Date(now.getTime() - 10 * 60 * 1000);
    const recentCompletion = new Date(now.getTime() - 9 * 60 * 1000);
    const stuckDelivery = new Date(now.getTime() - 20 * 60 * 1000);

    await sql`insert into workstreams (id, goal, flavor, status, tool, model, workspace_root)
      values (${workstreamId}, 'observability fixture', 'software-development', 'active', 'mock', 'deterministic', '')`;
    await sql`insert into tasks (id, workstream_id, title, status)
      values (${taskId}, ${workstreamId}, 'Complete the fixture task', 'done')`;
    await sql`insert into workflow_events (id, workstream_id, sequence, type, message, role, correlation_id, provider, occurred_at)
      values (${startedEventId}, ${workstreamId}, 1, 'run.started', 'fixture started', 'lead', ${correlationId}, 'mock', ${recentStart})`;
    await sql`insert into workflow_events (id, workstream_id, sequence, type, message, role, correlation_id, provider, occurred_at)
      values (${completedEventId}, ${workstreamId}, 2, 'task.completed', 'fixture completed', 'lead', ${correlationId}, 'mock', ${recentCompletion})`;
    await sql`insert into messages (id, workstream_id, sender_id, recipient_ids, message_type, content, correlation_id, created_at, delivery_status)
      values (${messageId}, ${workstreamId}, ${`${fixtureId}-sender`}, ${[`${fixtureId}-recipient`]}, 'update', 'fixture message', ${correlationId}, ${stuckDelivery}, 'delivered')`;
    await sql`insert into message_deliveries (message_id, recipient_id, delivery_status, delivered_at)
      values (${messageId}, ${`${fixtureId}-recipient`}, 'delivered', ${stuckDelivery})`;
    await sql`insert into triggers (id, name, enabled, kind, target_mode, target_workstream_id, duty_title, duty_prompt)
      values (${triggerId}, 'Observability fixture trigger', true, 'api', 'workstream', ${workstreamId}, 'Fixture duty', 'Complete the fixture duty')`;
    await sql`insert into trigger_fires (id, trigger_id, slot_key, status, workstream_id, duty_task_id, fired_at)
      values (${fireId}, ${triggerId}, ${fixtureId}, 'fired', ${workstreamId}, ${taskId}, ${now})`;
    await sql`insert into event_outbox (id, workstream_id, subject, envelope, status, attempts)
      values (${pendingOutboxId}, ${workstreamId}, 'fixture.pending', ${sql.json({ fixture: "pending" })}, 'pending', 2),
        (${deliveredOutboxId}, ${workstreamId}, 'fixture.delivered', ${sql.json({ fixture: "delivered" })}, 'delivered', 1)`;
  });

  afterAll(async () => {
    await sql`drop table if exists runtime_metric_counters`;
    await createEventOutbox();
    await sql`delete from event_outbox where id in (${pendingOutboxId}, ${deliveredOutboxId})`;
    await sql`delete from triggers where id = ${triggerId}`;
    await sql`delete from workstreams where id = ${workstreamId}`;
    await sql.end();
  });

  it("collects every series against the production-shaped schema without runtime_metric_counters", async () => {
    const samples = await collectObservabilityMetrics(sql, new Date());

    expect(samples).toContainEqual(
      expect.objectContaining({
        name: "agentweave_turns_total",
        labels: expect.objectContaining({ outcome: "success" }),
        value: 1,
      }),
    );
    expect(samples).toContainEqual({
      name: "agentweave_workstream_silence_seconds",
      labels: { workstream_id: workstreamId },
      value: expect.any(Number),
    });
    expect(samples).toContainEqual({
      name: "agentweave_stuck_delivered_messages_total",
      value: 1,
    });
    expect(samples).toContainEqual({
      name: "agentweave_duty_fulfillment_ratio",
      labels: { trigger_id: triggerId },
      value: 1,
    });
    expect(samples).toContainEqual({
      name: "agentweave_outbox_backlog",
      value: 1,
    });
    expect(samples).toContainEqual({
      name: "agentweave_outbox_delivered_total",
      value: 1,
    });
    expect(samples).toContainEqual({
      name: "agentweave_outbox_retry_total",
      value: 3,
    });
    expect(
      samples.some(({ name }) =>
        ["agentweave_replay_gap_total", "agentweave_redelivery_total"].includes(
          name,
        ),
      ),
    ).toBe(false);
  });

  it("emits durable counter series when runtime_metric_counters exists", async () => {
    await sql`create table runtime_metric_counters (name text primary key, value double precision not null default 0)`;
    await sql`insert into runtime_metric_counters (name, value) values ('replay_gap', 3), ('redelivery', 2)`;

    const samples = await collectObservabilityMetrics(sql, new Date());

    expect(samples).toContainEqual({
      name: "agentweave_replay_gap_total",
      value: 3,
    });
    expect(samples).toContainEqual({
      name: "agentweave_redelivery_total",
      value: 2,
    });
    await sql`drop table runtime_metric_counters`;
  });

  it("one broken group does not fail the collection", async () => {
    await sql`drop table event_outbox`;
    const errors: string[] = [];

    try {
      const samples = await collectObservabilityMetrics(
        sql,
        new Date(),
        (context) => {
          errors.push(context);
        },
      );

      expect(errors).toContain("event_outbox");
      expect(samples).toContainEqual({
        name: "agentweave_stuck_delivered_messages_total",
        value: 1,
      });
      expect(samples).not.toContainEqual(
        expect.objectContaining({ name: "agentweave_outbox_backlog" }),
      );
    } finally {
      await createEventOutbox();
    }
  });
});

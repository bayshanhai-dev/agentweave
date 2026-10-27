import type { Sql } from "postgres";

export type MetricSample = { name: string; labels?: Record<string, string>; value: number };

const HELP: Record<string, string> = {
  agentweave_turns_total: "Completed workflow runs classified by terminal outcome.",
  agentweave_workstream_silence_seconds: "Seconds since the latest non-heartbeat progress event for an active workstream.",
  agentweave_stuck_delivered_messages: "Delivered messages older than 15 minutes that are not acknowledged or failed.",
  agentweave_stuck_delivered_messages_total: "Total delivered messages older than 15 minutes that are not acknowledged or failed.",
  agentweave_duty_fulfillment_ratio: "Weekly fulfilled duty work divided by due duty work.",
  agentweave_duty_runs_total: "Weekly duty runs classified by outcome.",
  agentweave_outbox_backlog: "Current event outbox rows pending or publishing.",
  agentweave_outbox_delivered_total: "Durable count of delivered event outbox rows.",
  agentweave_outbox_retry_total: "Durable sum of event outbox retry attempts.",
  agentweave_outbox_dead_letter_total: "Durable count of dead-lettered event outbox rows.",
  agentweave_replay_gap_total: "Durable count of detected non-contiguous replay sequences.",
  agentweave_redelivery_total: "Durable count of redelivered runtime messages.",
  agentweave_requests_total: "HTTP requests received by the control API.", agentweave_workstreams_created_total: "Workstreams created by the control API.",
  agentweave_runs_started_total: "Workflow runs started by the control API.", agentweave_events_emitted_total: "Workflow events emitted by the control API.",
  agentweave_workflow_failures_total: "Workflow failures observed by the control API.", agentweave_provider_input_tokens_total: "Provider input tokens observed by the control API.",
  agentweave_provider_output_tokens_total: "Provider output tokens observed by the control API.", agentweave_provider_total_tokens_total: "Provider total tokens observed by the control API.",
  agentweave_provider_cost_usd: "Estimated provider cost in US dollars.",
};
const COUNTERS = new Set(["agentweave_turns_total", "agentweave_duty_runs_total", "agentweave_outbox_delivered_total", "agentweave_outbox_retry_total", "agentweave_outbox_dead_letter_total", "agentweave_replay_gap_total", "agentweave_redelivery_total", "agentweave_requests_total", "agentweave_workstreams_created_total", "agentweave_runs_started_total", "agentweave_events_emitted_total", "agentweave_workflow_failures_total", "agentweave_provider_input_tokens_total", "agentweave_provider_output_tokens_total", "agentweave_provider_total_tokens_total"]);

const boundedLabel = (value: unknown): string => String(value ?? "unknown").slice(0, 128);

const labelText = (labels: Record<string, string> = {}) => {
  const entries = Object.entries(labels);
  if (!entries.length) return "";
  return `{${entries.map(([key, value]) => {
    const safe = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
    return `${key}="${safe}"`;
  }).join(",")}}`;
};

export const renderPrometheus = (samples: MetricSample[]) => [...new Set([...Object.keys(HELP), ...samples.map((sample) => sample.name)])].map((name) => {
  const lines = [`# HELP ${name} ${HELP[name] ?? `${name} control-api metric.`}`, `# TYPE ${name} ${COUNTERS.has(name) ? "counter" : "gauge"}`];
  for (const sample of samples.filter((candidate) => candidate.name === name)) lines.push(`${name}${labelText(sample.labels)} ${Number.isFinite(sample.value) ? sample.value : 0}`);
  return lines.join("\n");
}).join("\n") + "\n";

/** Query-backed values are recomputed from PostgreSQL for every scrape. */
export async function collectObservabilityMetrics(
  sql: Sql,
  now = new Date(),
  onError: (context: string, error: unknown) => void = (context, error) =>
    console.error(context, error),
): Promise<MetricSample[]> {
  const progressTypes = ["run.started", "turn.started", "turn.completed", "workstream.created", "workstream.updated", "agent.reply.created"];
  const weekStart = new Date(now); weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7)); weekStart.setUTCHours(0, 0, 0, 0);
  const stuckCutoff = new Date(now.getTime() - 15 * 60 * 1000);

  const queryGroup = async <T>(context: string, query: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await query();
    } catch (error) {
      onError(context, error);
      return undefined;
    }
  };

  const [turns, silence, stuck, duties, outbox, durableCounters] = await Promise.all([
    queryGroup("turns", () => sql`select s.workstream_id, coalesce(s.role, t.role, 'unknown') as role, coalesce(s.provider, t.provider, 'unknown') as provider,
          case t.type when 'task.completed' then 'success' when 'task.failed' then 'failure' when 'task.gated' then 'gated' end as outcome, count(*)::double precision as count
        from workflow_events s join lateral (select e.type, e.role, e.provider from workflow_events e
          where e.workstream_id=s.workstream_id and e.type in ('task.completed','task.failed','task.gated') and
            ((s.correlation_id is not null and e.correlation_id=s.correlation_id) or (s.correlation_id is null and s.task_id is not null and e.task_id=s.task_id)) and e.occurred_at >= s.occurred_at
          order by e.occurred_at asc limit 1) t on true where s.type='run.started' group by 1,2,3,4`),
    queryGroup("silence", () => sql`select w.id, greatest(0, extract(epoch from (${now}::timestamptz - coalesce((select max(e.occurred_at) from workflow_events e where e.workstream_id=w.id and e.type <> 'run.heartbeat' and (e.type=any(${sql.array(progressTypes)}) or e.type like 'task.%' or e.type like 'message.%')), w.created_at))))::double precision as silence_seconds from workstreams w where w.status='active'`),
    queryGroup("stuck", () => sql`select w.id as workstream_id, count(d.*)::double precision as count from workstreams w left join messages m on m.workstream_id=w.id left join message_deliveries d on d.message_id=m.id and d.delivery_status='delivered' and d.delivered_at <= ${stuckCutoff} where w.status='active' group by w.id`),
    queryGroup("duties", () => sql`select t.id as trigger_id, t.enabled, count(f.*) filter (where f.status='fired' and f.fired_at >= ${weekStart} and f.fired_at <= ${now})::double precision as due, count(f.*) filter (where f.status='fired' and f.fired_at >= ${weekStart} and f.fired_at <= ${now} and task.status='done')::double precision as fulfilled, count(f.*) filter (where f.status='failed' and f.fired_at >= ${weekStart} and f.fired_at <= ${now})::double precision as failed, count(f.*) filter (where f.status='skipped' and f.fired_at >= ${weekStart} and f.fired_at <= ${now})::double precision as skipped, count(f.*) filter (where f.status='coalesced' and f.fired_at >= ${weekStart} and f.fired_at <= ${now})::double precision as coalesced from triggers t left join trigger_fires f on f.trigger_id=t.id left join tasks task on task.id=f.duty_task_id group by t.id,t.enabled`),
    queryGroup("event_outbox", () => sql`select (select count(*) filter (where status in ('pending','publishing')) from event_outbox)::double precision as backlog, (select count(*) from event_outbox where status='delivered')::double precision as delivered, (select coalesce(sum(attempts),0) from event_outbox)::double precision as retries, (select count(*) from event_outbox where status='dead_letter')::double precision as dead_letters`),
    queryGroup("durable counters", async () => {
      const [{ reg } = {}] = await sql`select to_regclass('runtime_metric_counters') as reg`;
      if (!reg) {
        onError("runtime_metric_counters absent; durable counter series skipped", new Error("runtime_metric_counters is absent"));
        return undefined;
      }
      const [row] = await sql`select (select coalesce(value,0) from runtime_metric_counters where name='replay_gap')::double precision as replay_gaps, (select coalesce(value,0) from runtime_metric_counters where name='redelivery')::double precision as redeliveries`;
      return row;
    }),
  ]);
  const samples: MetricSample[] = [];
  if (turns) for (const row of turns) if (row.outcome) samples.push({ name: "agentweave_turns_total", labels: { outcome: boundedLabel(row.outcome), workstream_id: boundedLabel(row.workstream_id), role: boundedLabel(row.role), provider: boundedLabel(row.provider) }, value: Math.max(0, Number(row.count)) });
  if (silence) for (const row of silence) samples.push({ name: "agentweave_workstream_silence_seconds", labels: { workstream_id: boundedLabel(row.id) }, value: Math.max(0, Number(row.silence_seconds)) });
  if (stuck) { let stuckTotal = 0; for (const row of stuck) { const count = Math.max(0, Number(row.count)); stuckTotal += count; samples.push({ name: "agentweave_stuck_delivered_messages", labels: { workstream_id: boundedLabel(row.workstream_id) }, value: count }); } samples.push({ name: "agentweave_stuck_delivered_messages_total", value: stuckTotal }); }
  if (duties) for (const row of duties) if (row.enabled) { const due = Math.max(0, Number(row.due)), fulfilled = Math.max(0, Number(row.fulfilled)), failed = Math.max(0, Number(row.failed)), skipped = Math.max(0, Number(row.skipped)), coalesced = Math.max(0, Number(row.coalesced)); const overdue = Math.max(0, due - fulfilled - failed - skipped - coalesced); samples.push({ name: "agentweave_duty_fulfillment_ratio", labels: { trigger_id: boundedLabel(row.trigger_id) }, value: due ? Math.min(1, fulfilled / due) : 0 }); for (const [outcome, value] of [["fulfilled", fulfilled], ["failed", failed], ["skipped", skipped], ["coalesced", coalesced], ["overdue", overdue]] as const) samples.push({ name: "agentweave_duty_runs_total", labels: { trigger_id: boundedLabel(row.trigger_id), outcome }, value }); }
  if (outbox) { const durable = outbox[0] ?? {}; samples.push({ name: "agentweave_outbox_backlog", value: Number(durable.backlog ?? 0) }, { name: "agentweave_outbox_delivered_total", value: Number(durable.delivered ?? 0) }, { name: "agentweave_outbox_retry_total", value: Number(durable.retries ?? 0) }, { name: "agentweave_outbox_dead_letter_total", value: Number(durable.dead_letters ?? 0) }); }
  if (durableCounters) samples.push({ name: "agentweave_replay_gap_total", value: Number(durableCounters.replay_gaps ?? 0) }, { name: "agentweave_redelivery_total", value: Number(durableCounters.redeliveries ?? 0) });
  return samples;
}

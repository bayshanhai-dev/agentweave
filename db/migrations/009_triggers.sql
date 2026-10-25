create table if not exists triggers (
  id text primary key,
  name text not null,
  enabled boolean not null default true,
  kind text not null check (kind in ('schedule', 'api')),
  cron_expr text,
  timezone text not null default 'UTC',
  target_mode text not null check (target_mode in ('workstream', 'create')),
  target_workstream_id text,
  template_id text,
  goal_template text,
  duty_title text not null,
  duty_prompt text not null,
  priority integer not null default 0,
  max_runs_per_day integer,
  quiet_start text,
  quiet_end text,
  batch_window_sec integer not null default 0,
  overlap_policy text not null default 'skip' check (overlap_policy in ('skip', 'allow')),
  last_fired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'schedule' and cron_expr is not null) or (kind = 'api' and cron_expr is null)),
  check ((target_mode = 'workstream' and target_workstream_id is not null and template_id is null and goal_template is null)
    or (target_mode = 'create' and template_id is not null and goal_template is not null and target_workstream_id is null)),
  check ((quiet_start is null and quiet_end is null) or (quiet_start is not null and quiet_end is not null)),
  check (max_runs_per_day is null or max_runs_per_day > 0),
  check (batch_window_sec >= 0)
);

create table if not exists trigger_fires (
  id text primary key,
  trigger_id text not null references triggers(id) on delete cascade,
  slot_key text not null,
  status text not null check (status in ('fired', 'skipped', 'coalesced', 'failed')),
  reason text,
  workstream_id text,
  message_id text,
  fired_at timestamptz not null default now(),
  unique (trigger_id, slot_key)
);

create index if not exists trigger_fires_trigger_time_idx on trigger_fires(trigger_id, fired_at desc);
create index if not exists trigger_fires_time_idx on trigger_fires(fired_at desc);

create table if not exists duty_state (
  workstream_id text not null references workstreams(id) on delete cascade,
  state_key text not null,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (workstream_id, state_key)
);

alter table triggers add column if not exists state_key text;
alter table trigger_fires add column if not exists duty_task_id text;

create index if not exists trigger_fires_duty_task_idx on trigger_fires(duty_task_id)
  where duty_task_id is not null;

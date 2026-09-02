alter table workflow_events add column if not exists sequence bigint;

with ranked as (
  select id, row_number() over (partition by workstream_id order by occurred_at asc, id asc) as sequence
  from workflow_events
)
update workflow_events event
set sequence = ranked.sequence
from ranked
where event.id = ranked.id and event.sequence is null;

alter table workflow_events alter column sequence set not null;
create unique index if not exists workflow_events_workstream_sequence_idx on workflow_events(workstream_id, sequence);

create table if not exists projector_checkpoints (
  projector text not null,
  workstream_id text not null references workstreams(id) on delete cascade,
  last_sequence bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (projector, workstream_id)
);

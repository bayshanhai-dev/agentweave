create table if not exists workstreams (
  id text primary key,
  goal text not null,
  flavor text not null,
  status text not null,
  tool text not null,
  model text not null,
  workspace_root text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tasks (
  id text primary key,
  workstream_id text not null references workstreams(id) on delete cascade,
  title text not null,
  status text not null,
  owner_agent_id text,
  created_by_agent_id text,
  parent_task_id text,
  related_task_ids jsonb not null default '[]',
  acceptance_criteria jsonb not null default '[]',
  dependencies jsonb not null default '[]',
  evidence jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tasks add column if not exists created_by_agent_id text;
alter table tasks add column if not exists parent_task_id text;
alter table tasks add column if not exists related_task_ids jsonb not null default '[]';

create table if not exists agents (
  id text primary key,
  workstream_id text not null references workstreams(id) on delete cascade,
  role text not null,
  authority text not null,
  status text not null
);

create table if not exists workflow_events (
  id text primary key,
  workstream_id text not null references workstreams(id) on delete cascade,
  type text not null,
  message text not null,
  role text,
  from_node text,
  to_node text,
  agent_id text,
  task_id text,
  correlation_id text,
  provider text,
  model text,
  usage jsonb,
  occurred_at timestamptz not null
);

alter table workflow_events add column if not exists from_node text;
alter table workflow_events add column if not exists to_node text;
alter table workflow_events add column if not exists agent_id text;
alter table workflow_events add column if not exists task_id text;
alter table workflow_events add column if not exists correlation_id text;
alter table workflow_events add column if not exists provider text;
alter table workflow_events add column if not exists model text;
alter table workflow_events add column if not exists usage jsonb;

create table if not exists messages (
  id text primary key,
  workstream_id text not null references workstreams(id) on delete cascade,
  sender_id text not null,
  recipient_ids text[] not null,
  message_type text not null,
  content text not null,
  task_id text,
  correlation_id text not null,
  causation_id text,
  evidence_ids jsonb not null default '[]',
  created_at timestamptz not null default now(),
  delivery_status text not null default 'pending'
);

create table if not exists message_deliveries (
  message_id text not null references messages(id) on delete cascade,
  recipient_id text not null,
  delivery_status text not null default 'pending',
  delivered_at timestamptz,
  primary key (message_id, recipient_id)
);

create table if not exists workstream_commands (
  workstream_id text not null references workstreams(id) on delete cascade,
  command_id text not null,
  command text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (workstream_id, command_id)
);

create table if not exists task_execution_claims (
  task_id text primary key,
  workstream_id text,
  worker_id text not null,
  message_id text not null,
  status text not null default 'active',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  lease_expires_at timestamptz not null
);

create table if not exists consumed_runtime_events (
  id text primary key,
  workstream_id text not null,
  event_type text not null,
  consumed_at timestamptz not null default now()
);

create table if not exists workspace_evidence (
  id bigserial primary key,
  task_id text not null references tasks(id) on delete cascade,
  workspace_path text not null,
  git_diff text not null,
  test_command text,
  test_output text,
  test_exit_code integer,
  kind text not null default 'workspace',
  warnings jsonb not null default '[]',
  created_at timestamptz not null default now()
);

alter table workspace_evidence add column if not exists kind text not null default 'workspace';
alter table workspace_evidence add column if not exists warnings jsonb not null default '[]';

create table if not exists runtime_workers (
  id text primary key,
  provider text not null,
  provider_model text not null default 'default',
  endpoint text,
  roles text[] not null default '{}',
  capabilities text[] not null default '{}',
  status text not null default 'offline',
  current_task_id text,
  last_heartbeat_at timestamptz,
  registered_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table runtime_workers add column if not exists provider_model text not null default 'default';
alter table runtime_workers add column if not exists endpoint text;

create index if not exists task_execution_claims_lease_idx on task_execution_claims(status, lease_expires_at);
create index if not exists runtime_workers_heartbeat_idx on runtime_workers(status, last_heartbeat_at);
create index if not exists agent_sessions_lease_idx on agent_sessions(status, lease_expires_at);
create index if not exists messages_workstream_created_idx on messages(workstream_id, created_at);
create index if not exists messages_recipient_idx on messages using gin(recipient_ids);
create index if not exists workflow_events_workstream_time_idx on workflow_events(workstream_id, occurred_at);
create index if not exists workflow_events_correlation_idx on workflow_events(correlation_id);

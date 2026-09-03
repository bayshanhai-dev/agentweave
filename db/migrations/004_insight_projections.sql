create table if not exists insights (
  id text primary key,
  workstream_id text not null references workstreams(id) on delete cascade,
  kind text not null,
  lifecycle text not null,
  author_agent_id text not null,
  content text not null,
  confidence double precision not null check (confidence >= 0 and confidence <= 1),
  insight_references jsonb not null default '[]',
  contradiction_of jsonb not null default '[]',
  supersedes jsonb not null default '[]',
  evidence_ids jsonb not null default '[]',
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists insights_workstream_lifecycle_idx on insights(workstream_id, lifecycle, updated_at desc);
create index if not exists insights_references_idx on insights using gin(insight_references);
create index if not exists insights_contradictions_idx on insights using gin(contradiction_of);

create table if not exists collaboration_rounds (
  id text primary key,
  workstream_id text not null references workstreams(id) on delete cascade,
  topic text not null,
  participant_agent_ids jsonb not null,
  synthesizer_agent_id text not null,
  max_turns integer not null check (max_turns > 0),
  deadline timestamptz not null,
  completion_rule text not null,
  status text not null,
  insight_ids jsonb not null default '[]',
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists collaboration_rounds_workstream_status_idx on collaboration_rounds(workstream_id, status, deadline);

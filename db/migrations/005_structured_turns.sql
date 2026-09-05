create table if not exists structured_turns (
  id text primary key,
  workstream_id text not null references workstreams(id) on delete cascade,
  fingerprint text not null,
  plan jsonb not null,
  created_at timestamptz not null default now()
);

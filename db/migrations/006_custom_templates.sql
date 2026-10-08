create table if not exists custom_workstream_templates (
  id text primary key,
  template jsonb not null,
  created_at timestamptz not null default now()
);

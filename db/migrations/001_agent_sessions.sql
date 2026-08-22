create table if not exists agent_sessions (
  id text primary key,
  agent_id text not null,
  provider text not null,
  provider_session_id text not null,
  status text not null check (status in ('active', 'completed', 'failed', 'cancelled')),
  current_turn_id text,
  last_checkpoint jsonb,
  last_event_sequence bigint not null default 0,
  worker_id text,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists agent_sessions_provider_session_idx on agent_sessions(provider, provider_session_id);
create index if not exists agent_sessions_recovery_idx on agent_sessions(status, lease_expires_at);

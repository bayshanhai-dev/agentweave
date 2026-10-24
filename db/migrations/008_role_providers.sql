alter table workstreams alter column tool drop not null;
alter table workstreams alter column model drop not null;
alter table workstreams add column if not exists role_providers jsonb not null default '{}';

alter table tasks add column if not exists quality_attempts integer not null default 0;
alter table workflow_events add column if not exists tool_name text;
alter table workflow_events add column if not exists output text;

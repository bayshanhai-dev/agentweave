-- Load gate for triggers (#131): when max_open_tasks is set, a scheduled
-- fire is skipped with reason 'busy' while the target workstream already
-- holds at least that many open (non-terminal) tasks. Null means no gate.
alter table triggers add column if not exists max_open_tasks integer;

alter table triggers drop constraint if exists triggers_max_open_tasks_nonnegative;
alter table triggers add constraint triggers_max_open_tasks_nonnegative
  check (max_open_tasks is null or max_open_tasks >= 0);

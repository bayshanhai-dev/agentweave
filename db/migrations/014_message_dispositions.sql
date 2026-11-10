alter table messages add column if not exists terminal_status text;
alter table messages add column if not exists terminal_reason text;
alter table messages add column if not exists terminal_at timestamptz;
alter table messages drop constraint if exists messages_terminal_status_check;
alter table messages add constraint messages_terminal_status_check check (terminal_status is null or terminal_status in ('dismissed'));

-- The four audited historical human messages were stale queue traffic, not
-- work to re-drive. Their content/date selectors make the disposition visible
-- on a fresh deployment without inventing a new turn or touching active work.
update messages m
set terminal_status = 'dismissed', terminal_reason = case
  when m.content ilike '%implementation-trigger%' then 'Historical X-growth goal implementation trigger; the workstream has already progressed and must not be re-driven.'
  when m.content ilike '%[X-DATA RESULT]%' then 'Historical X-growth baseline reply; retained for audit but no longer actionable.'
  when m.content ilike '%GLOBAL METRICS WATCH%' then 'Historical owner-team metrics report; superseded by later watch cycles.'
  when m.content ilike '%Format request #5%' then 'Historical X-growth format probe; superseded and intentionally not re-driven.'
end, terminal_at = coalesce(terminal_at, now())
from workstreams w
where m.workstream_id = w.id
  and m.sender_id = 'human'
  and m.terminal_status is null
  and (
    (m.created_at >= '2026-10-26T00:00:00Z' and m.created_at < '2026-10-27T00:00:00Z' and (m.content ilike '%implementation-trigger%' or m.content ilike '%[X-DATA RESULT]%'))
    or (m.created_at >= '2026-10-29T15:00:00Z' and m.created_at < '2026-10-30T00:00:00Z' and m.content ilike '%GLOBAL METRICS WATCH%')
    or (m.created_at >= '2026-11-02T00:00:00Z' and m.created_at < '2026-11-03T00:00:00Z' and m.content ilike '%Format request #5%')
  );

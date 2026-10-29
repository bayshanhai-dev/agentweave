alter table triggers add column if not exists target_role text;
alter table triggers add column if not exists completion_evidence text not null default 'attestation' check (completion_evidence in ('attestation', 'deliverable'));

create or replace view public.engrep_window_summary
with (security_invoker = true) as
  select w.id as window_id, w.granularity, w.period_start, w.period_end,
         w.status, w.harvested_at, w.locked_at,
         count(r.id) filter (where r.source='lovable_edit')       as lovable_edits,
         count(r.id) filter (where r.source='external_commit')    as external_commits,
         count(r.id) filter (where r.claims_schema)               as claiming_schema,
         count(r.id) filter (where r.claims_schema and r.live_verified='yes') as live_verified,
         count(r.id) filter (where r.untagged)                    as untagged,
         count(r.id) filter (where r.fenced_breach)               as fenced_breaches,
         count(r.id) filter (where r.self_fix)                    as self_fixes,
         count(r.id) filter (where r.zeroed)                      as zeroed,
         count(r.id) filter (where not r.zeroed and r.band is null) as unadjudicated,
         count(distinct r.author_email) filter (where r.source='external_commit') as distinct_author_emails
  from public.engrep_windows w
  left join public.engrep_rows r on r.window_id = w.id
  group by w.id, w.granularity, w.period_start, w.period_end,
           w.status, w.harvested_at, w.locked_at;

create or replace view public.engrep_banded_rollup
with (security_invoker = true) as
  select w.granularity, w.period_start, w.period_end,
         r.engineer_code, r.band, count(*) as rows_banded
  from public.engrep_rows r
  join public.engrep_windows w on w.id = r.window_id
  where r.band is not null and w.status = 'locked'
  group by w.granularity, w.period_start, w.period_end, r.engineer_code, r.band;

create or replace view public.engrep_my_rows
with (security_invoker = true) as
  select r.id, w.granularity, w.period_start, w.period_end, w.status,
         r.source, r.evidence_ref, r.commit_subject, r.change_classes,
         r.claims_schema, r.live_verified, r.zeroed, r.zero_reason,
         r.band, r.basis, r.adjudicated_at
  from public.engrep_rows r
  join public.engrep_windows w on w.id = r.window_id
  where r.engineer_id in (
    select e.id from public.engrep_engineers e
    where e.staff_id = public.hr_my_staff_id()
  );
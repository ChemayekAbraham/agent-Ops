-- 2026-09-11 Daily CTO Report: cron job "engrep-resolve-lineage" broken all
-- day, every run failing with:
--   ERROR: new row for relation "engrep_rows" violates check constraint
--   "engrep_rows_selffix"
--
-- public.engrep_svc_resolve_lineage() (20260910203647_920af85e-2af9-4521-
-- 86ce-b3edbb815d56.sql) detects that a row is a same-engineer retry of an
-- earlier row whose live_verified='no' on an overlapping claimed object,
-- and marks it self_fix = true — but only checked EXISTS(...) for that
-- prior row and never captured *which* row it was, so the UPDATE never set
-- self_fix_of. The table's own constraint
--   check (not self_fix or self_fix_of is not null)
-- rejects exactly that combination on every single row that qualifies,
-- which is why the job has "no successful run in the last 24h" per the
-- report (1/1 failures) rather than an intermittent failure.
--
-- Fix: capture the id of the most recent qualifying prior row (same
-- ordering the EXISTS check already implied) and store it in self_fix_of.

CREATE OR REPLACE FUNCTION public.engrep_svc_resolve_lineage(p_window_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_status text;
  v_self_fix_count integer := 0;
  r record;
  v_self_fix_of uuid;
  v_recurrence integer;
begin
  select status into v_status from public.engrep_windows where id = p_window_id;
  if v_status is null then
    raise exception 'engrep window % not found', p_window_id;
  end if;
  if v_status = 'locked' then
    raise exception 'engrep window % is locked; lineage resolution refused', p_window_id;
  end if;

  for r in
    select id, engineer_id, claimed_objects, paths, committed_at, harvested_at
    from public.engrep_rows
    where window_id = p_window_id
      and engineer_id is not null
  loop
    select p.id
      into v_self_fix_of
      from public.engrep_rows p
      where p.engineer_id = r.engineer_id
        and p.id <> r.id
        and p.live_verified = 'no'
        and p.claimed_objects && r.claimed_objects
        and coalesce(p.committed_at, p.harvested_at)
              < coalesce(r.committed_at, r.harvested_at)
        and coalesce(p.committed_at, p.harvested_at)
              >= coalesce(r.committed_at, r.harvested_at) - interval '14 days'
      order by coalesce(p.committed_at, p.harvested_at) desc
      limit 1;

    if v_self_fix_of is not null then
      update public.engrep_rows
         set self_fix = true,
             self_fix_of = v_self_fix_of,
             recurrence_kind = 'object_retry'
       where id = r.id;
      v_self_fix_count := v_self_fix_count + 1;
    else
      select count(distinct p.id)
        into v_recurrence
      from public.engrep_rows p
      where p.engineer_id = r.engineer_id
        and p.id <> r.id
        and p.paths && r.paths
        and coalesce(p.committed_at, p.harvested_at)
              < coalesce(r.committed_at, r.harvested_at)
        and coalesce(p.committed_at, p.harvested_at)
              >= coalesce(r.committed_at, r.harvested_at) - interval '7 days';

      update public.engrep_rows
         set recurrence_count = coalesce(v_recurrence, 0),
             recurrence_kind = case when coalesce(v_recurrence, 0) > 0
                                    then 'path_revisit' else recurrence_kind end
       where id = r.id;
    end if;
  end loop;

  return v_self_fix_count;
end
$function$;

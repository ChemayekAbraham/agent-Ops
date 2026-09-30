CREATE OR REPLACE FUNCTION public.engrep_refresh_catalog_movement(p_since date DEFAULT NULL::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_since date := coalesce(p_since, current_date - 7);
  v_n integer;
begin
  create temporary table tmp_mov on commit drop as
  select l.captured_for,
         l.object_kind,
         l.object_key,
         l.object_base,
         l.fingerprint,
         l.prev_fingerprint,
         -- cutover suppresses movement only for objects also present in the previous day's snapshot;
         -- an object appearing for the first time on the cutover day keeps its movement.
         case when exists (select 1 from public.engrep_catalog_cutovers co
                            where co.object_kind = l.object_kind
                              and co.cutover_day = l.captured_for)
                   and l.prev_captured_for = l.captured_for - 1
              then false
              else (l.fingerprint is distinct from l.prev_fingerprint) end as moved_from_prev
    from (
      select s.captured_for, s.object_kind, s.object_key, s.object_base, s.fingerprint,
             lag(s.fingerprint) over w as prev_fingerprint,
             lag(s.captured_for) over w as prev_captured_for
        from public.engrep_catalog_snapshot s
      window w as (partition by s.object_kind, s.object_key order by s.captured_for)
    ) l;

  create index tmp_mov_since on tmp_mov (captured_for);

  create temporary table tmp_moved_days on commit drop as
  select distinct object_base, captured_for from tmp_mov where moved_from_prev;

  create index tmp_moved_days_idx on tmp_moved_days (object_base, captured_for);
  analyze tmp_mov;
  analyze tmp_moved_days;

  insert into public.engrep_catalog_movement as m (
    captured_for, object_kind, object_key, object_base,
    fingerprint, prev_fingerprint, moved_from_prev, moved_nearby)
  select t.captured_for, t.object_kind, t.object_key, t.object_base,
         t.fingerprint, t.prev_fingerprint, t.moved_from_prev,
         exists (
           select 1 from tmp_moved_days d
            where d.object_base = t.object_base
              and d.captured_for between t.captured_for - 3 and t.captured_for + 3
         ) as moved_nearby
    from tmp_mov t
   where t.captured_for >= v_since
  on conflict (captured_for, object_kind, object_key) do update
     set object_base      = excluded.object_base,
         fingerprint      = excluded.fingerprint,
         prev_fingerprint = excluded.prev_fingerprint,
         moved_from_prev  = excluded.moved_from_prev,
         moved_nearby     = excluded.moved_nearby;

  get diagnostics v_n = row_count;
  return v_n;
end $function$;

CREATE OR REPLACE FUNCTION public.engrep_reevaluate_liveness(p_window date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_changed integer := 0;
  v_rescore_yes boolean := coalesce(current_setting('engrep.rescore_yes', true), '') = 'on';
  v_latest date;
begin
  select max(captured_for) into v_latest from public.engrep_catalog_snapshot;

  with target as (
    select x.id, x.claimed_objects, x.committed_at
      from public.engrep_rows x
      join public.engrep_windows w on w.id = x.window_id
     where w.period_start = p_window
       and x.claims_schema
       and (x.live_verified in ('no', 'part') or (v_rescore_yes and x.live_verified = 'yes'))
  ),
  objs as (
    select t.id, t.committed_at, co.obj
      from target t
      cross join lateral unnest(coalesce(t.claimed_objects, '{}'::text[])) as co(obj)
     where not (co.obj ~ '^[A-Z]'
                or co.obj ~ '^tmp_'
                or lower(co.obj) in ('cannot','finance','engrep','public','select','insert',
                                     'update','delete','all','usage','execute','only'))
  ),
  counted as (
    select t.id,
           (select count(*) from objs o where o.id = t.id) as total,
           (select count(*) from objs o
             where o.id = t.id
               and (
                 -- (a) moved on a snapshot captured after the commit, within 3 days of it
                 exists (
                   select 1
                     from public.engrep_catalog_movement m
                     join public.engrep_catalog_snapshot s
                       on s.captured_for = m.captured_for
                      and s.object_kind  = m.object_kind
                      and s.object_key   = m.object_key
                    where (m.object_base = split_part(o.obj, '(', 1)
                           or m.object_base like '%.' || split_part(o.obj, '(', 1))
                      and m.moved_from_prev
                      and s.captured_at >  o.committed_at
                      and s.captured_at <= o.committed_at + interval '3 days')
                 -- (b) the commit created it: in the latest snapshot, in none before the commit
                 or (exists (
                       select 1 from public.engrep_catalog_snapshot s
                        where s.captured_for = v_latest
                          and (s.object_base = split_part(o.obj, '(', 1)
                               or s.object_base like '%.' || split_part(o.obj, '(', 1)))
                     and not exists (
                       select 1 from public.engrep_catalog_snapshot s
                        where s.captured_at < o.committed_at
                          and (s.object_base = split_part(o.obj, '(', 1)
                               or s.object_base like '%.' || split_part(o.obj, '(', 1))))
               )) as landed
      from target t
  ),
  scored as (
    select c.id, c.total, c.landed,
           (c.total > 0) as schema_claim,
           case when c.total = 0 then 'na'
                when c.landed >= c.total then 'yes'
                when c.landed > 0 then 'part'
                else 'no' end as lv
      from counted c
  ),
  upd as (
    update public.engrep_rows x
       set claims_schema = s.schema_claim,
           claims_total  = s.total,
           claims_landed = s.landed,
           live_verified = s.lv
      from scored s
     where x.id = s.id
       and (x.claims_schema is distinct from s.schema_claim
            or x.claims_total is distinct from s.total
            or x.claims_landed is distinct from s.landed
            or x.live_verified is distinct from s.lv)
    returning 1
  )
  select count(*) into v_changed from upd;
  return v_changed;
end;
$function$;

REVOKE ALL ON FUNCTION public.engrep_refresh_catalog_movement(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.engrep_reevaluate_liveness(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.engrep_refresh_catalog_movement(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.engrep_reevaluate_liveness(date) TO service_role;

REVOKE ALL ON public.engrep_file_survival FROM authenticated, anon, PUBLIC;
REVOKE ALL ON public.engrep_commit_survival FROM authenticated, anon, PUBLIC;
GRANT SELECT ON public.engrep_file_survival TO authenticated;
GRANT SELECT ON public.engrep_commit_survival TO authenticated;

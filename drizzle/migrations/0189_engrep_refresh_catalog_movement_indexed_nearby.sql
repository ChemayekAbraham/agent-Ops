-- ENGREP-MOVEMENT-20260918-T follow-up: the moved_nearby EXISTS scanned the whole
-- per-object temp table once per row (232k x 232k). Reduce to distinct
-- (object_base, moved day) pairs in an indexed temp table before the lookup.

CREATE OR REPLACE FUNCTION public.engrep_refresh_catalog_movement(p_since date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_since date := coalesce(p_since, current_date - 7);
  v_n integer;
begin
  -- pass 1: per-object movement against the most recent earlier snapshot day.
  -- computed over full history so the first in-scope day sees its true predecessor.
  create temporary table tmp_mov on commit drop as
  select l.captured_for,
         l.object_kind,
         l.object_key,
         l.object_base,
         l.fingerprint,
         l.prev_fingerprint,
         (l.fingerprint is distinct from l.prev_fingerprint) as moved_from_prev
    from (
      select s.captured_for, s.object_kind, s.object_key, s.object_base, s.fingerprint,
             lag(s.fingerprint) over (
               partition by s.object_kind, s.object_key
               order by s.captured_for) as prev_fingerprint
        from public.engrep_catalog_snapshot s
    ) l;

  create index tmp_mov_since on tmp_mov (captured_for);

  -- pass 2 input: distinct base/day pairs that moved, indexed for the range probe.
  create temporary table tmp_moved_days on commit drop as
  select distinct object_base, captured_for from tmp_mov where moved_from_prev;

  create index tmp_moved_days_idx on tmp_moved_days (object_base, captured_for);
  analyze tmp_mov;
  analyze tmp_moved_days;

  insert into public.engrep_catalog_movement as m (
    captured_for, object_kind, object_key, object_base,
    fingerprint, prev_fingerprint, moved_from_prev, moved_nearby)
  select t.captured_for,
         t.object_kind,
         t.object_key,
         t.object_base,
         t.fingerprint,
         t.prev_fingerprint,
         t.moved_from_prev,
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

-- ECHO: ENGREP-MOVEMENT-20260918-T
-- Precomputed daily fingerprint-movement facts so work_units/repetition need not
-- rescan engrep_catalog_snapshot at query time.

CREATE TABLE public.engrep_catalog_movement (
  captured_for      date    NOT NULL,
  object_kind       text    NOT NULL,
  object_key        text    NOT NULL,
  object_base       text    NOT NULL,
  fingerprint       text    NOT NULL,
  prev_fingerprint  text,
  moved_from_prev   boolean NOT NULL DEFAULT false,
  moved_nearby      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (captured_for, object_kind, object_key)
);

CREATE INDEX engrep_mov_base_day
  ON public.engrep_catalog_movement (object_base, captured_for DESC);
CREATE INDEX engrep_mov_moved
  ON public.engrep_catalog_movement (captured_for) WHERE moved_from_prev;

GRANT SELECT ON public.engrep_catalog_movement TO authenticated;
GRANT ALL ON public.engrep_catalog_movement TO service_role;

ALTER TABLE public.engrep_catalog_movement ENABLE ROW LEVEL SECURITY;

-- predicate copied verbatim from policy engrep_cat_select on engrep_catalog_snapshot
CREATE POLICY engrep_mov_select ON public.engrep_catalog_movement
  FOR SELECT
  USING (engrep_is_adjudicator() OR has_role(auth.uid(), 'cto'::app_role));

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
  -- computed over the full history so the first in-scope day sees its true
  -- predecessor, then restricted to the refresh window on write.
  create temporary table tmp_mov on commit drop as
  with lagged as (
    select s.captured_for,
           s.object_kind,
           s.object_key,
           s.object_base,
           s.fingerprint,
           lag(s.fingerprint) over (
             partition by s.object_kind, s.object_key
             order by s.captured_for) as prev_fingerprint
      from public.engrep_catalog_snapshot s
  )
  select l.captured_for,
         l.object_kind,
         l.object_key,
         l.object_base,
         l.fingerprint,
         l.prev_fingerprint,
         (l.fingerprint is distinct from l.prev_fingerprint) as moved_from_prev
    from lagged l;

  -- pass 2: moved_nearby over object_base, +/- 3 days either side.
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
           select 1
             from tmp_mov n
            where n.object_base = t.object_base
              and n.moved_from_prev
              and n.captured_for between t.captured_for - 3 and t.captured_for + 3
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

REVOKE ALL ON FUNCTION public.engrep_refresh_catalog_movement(date) FROM public;
GRANT EXECUTE ON FUNCTION public.engrep_refresh_catalog_movement(date) TO service_role;

-- daily snapshot job hook: unchanged body, one appended final action.
CREATE OR REPLACE FUNCTION public.engrep_capture_catalog(p_day date DEFAULT NULL::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_day date := coalesce(p_day, (now() at time zone 'Africa/Kampala')::date);
  v_n integer;
begin
  -- last call of the day is authoritative. a merge would keep a stale fingerprint
  -- on a changed object and never remove a dropped one.
  delete from public.engrep_catalog_snapshot where captured_for = v_day;

  insert into public.engrep_catalog_snapshot (captured_for, object_kind, object_key, fingerprint)
  select v_day, k.object_kind, k.object_key, k.fingerprint
  from (
    select 'table'::text, c.relname::text, md5(c.relkind::text)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname='public' and c.relkind='r'
    union all
    select 'view', c.relname::text,
           md5(coalesce(pg_get_viewdef(c.oid), '') || coalesce(c.reloptions::text,''))
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname='public' and c.relkind='v'
    union all
    select 'column', a.attrelid::regclass::text || '.' || a.attname,
           md5(format_type(a.atttypid, a.atttypmod) || a.attnotnull::text)
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname='public' and c.relkind in ('r','v')
        and a.attnum > 0 and not a.attisdropped
    union all
    select 'function', p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           md5(pg_get_functiondef(p.oid))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.prokind in ('f','p')
    union all
    select 'trigger', t.tgrelid::regclass::text || '.' || t.tgname,
           md5(pg_get_triggerdef(t.oid))
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname='public' and not t.tgisinternal
    union all
    select 'policy', pol.tablename || '.' || pol.policyname,
           md5(pol.cmd || coalesce(pol.qual,'') || coalesce(pol.with_check,''))
      from pg_policies pol where pol.schemaname='public'
    union all
    select 'index', i.indexname::text, md5(i.indexdef)
      from pg_indexes i where i.schemaname='public'
  ) as k(object_kind, object_key, fingerprint);
  get diagnostics v_n = row_count;

  -- appended by ENGREP-MOVEMENT-20260918-T: last action, after snapshot rows land.
  perform public.engrep_refresh_catalog_movement(null);

  return v_n;
end $function$;

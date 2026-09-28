CREATE TABLE public.engrep_catalog_cutovers (
  object_kind text PRIMARY KEY,
  cutover_day date NOT NULL
);
GRANT SELECT ON public.engrep_catalog_cutovers TO authenticated;
GRANT ALL ON public.engrep_catalog_cutovers TO service_role;
ALTER TABLE public.engrep_catalog_cutovers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "engrep_catalog_cutovers_read" ON public.engrep_catalog_cutovers
  FOR SELECT TO authenticated USING (true);

INSERT INTO public.engrep_catalog_cutovers (object_kind, cutover_day)
SELECT k, (now() at time zone 'Africa/Kampala')::date
  FROM unnest(array['table','constraint']) k;

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
  delete from public.engrep_catalog_snapshot where captured_for = v_day;

  insert into public.engrep_catalog_snapshot (captured_for, object_kind, object_key, fingerprint)
  select v_day, k.object_kind, k.object_key, k.fingerprint
  from (
    select 'table'::text, c.relname::text,
           md5(c.relrowsecurity::text || ':' || c.relforcerowsecurity::text || '|' ||
               coalesce((
                 select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' ||
                                   a.attnotnull::text || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''),
                                   ',' order by a.attnum)
                   from pg_attribute a
                   left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                  where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
               ), ''))
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
    union all
    select 'constraint', con.conrelid::regclass::text || '.' || con.conname,
           md5(pg_get_constraintdef(con.oid))
      from pg_constraint con join pg_namespace n on n.oid = con.connamespace
      where n.nspname='public' and con.conrelid <> 0
  ) as k(object_kind, object_key, fingerprint);
  get diagnostics v_n = row_count;

  perform public.engrep_refresh_catalog_movement(null);

  return v_n;
end $function$;

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
         case when exists (select 1 from public.engrep_catalog_cutovers co
                            where co.object_kind = l.object_kind
                              and co.cutover_day = l.captured_for)
              then false
              else (l.fingerprint is distinct from l.prev_fingerprint) end as moved_from_prev
    from (
      select s.captured_for, s.object_kind, s.object_key, s.object_base, s.fingerprint,
             lag(s.fingerprint) over (
               partition by s.object_kind, s.object_key
               order by s.captured_for) as prev_fingerprint
        from public.engrep_catalog_snapshot s
    ) l;

  create index tmp_mov_since on tmp_mov (captured_for);

  -- cutover rows carry moved_from_prev = false, so they never enter moved_nearby.
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
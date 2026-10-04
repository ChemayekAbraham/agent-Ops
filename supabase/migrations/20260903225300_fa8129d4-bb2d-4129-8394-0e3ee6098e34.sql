create or replace function public.engrep_capture_catalog(p_day date default null)
returns integer language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
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
  return v_n;
end $fn$;
create table if not exists public.engrep_catalog_snapshot (
  id bigserial primary key,
  captured_for date not null,
  captured_at timestamptz not null default now(),
  object_kind text not null,
  object_key text not null,
  fingerprint text not null,
  constraint engrep_cat_kind
    check (object_kind in ('table','column','view','function','trigger','policy','index'))
);
create unique index if not exists engrep_cat_uk
  on public.engrep_catalog_snapshot (captured_for, object_kind, object_key);
create index if not exists engrep_cat_day on public.engrep_catalog_snapshot (captured_for);

grant select on public.engrep_catalog_snapshot to authenticated;
grant all on public.engrep_catalog_snapshot to service_role;

create or replace function public.engrep_capture_catalog(p_day date default null)
returns integer language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
declare
  v_day date := coalesce(p_day, (now() at time zone 'Africa/Kampala')::date);
  v_n integer;
begin
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
  ) as k(object_kind, object_key, fingerprint)
  on conflict (captured_for, object_kind, object_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $fn$;

create or replace function public.engrep_catalog_delta(p_day date)
returns table (object_kind text, object_key text, change text)
language sql stable security definer
set search_path to 'public','pg_temp' as $fn$
  with prev_day as (
    select max(captured_for) d from public.engrep_catalog_snapshot where captured_for < p_day
  ),
  cur as (
    select object_kind, object_key, fingerprint
    from public.engrep_catalog_snapshot where captured_for = p_day
  ),
  prv as (
    select object_kind, object_key, fingerprint
    from public.engrep_catalog_snapshot
    where captured_for = (select d from prev_day)
  )
  select coalesce(c.object_kind, p.object_kind),
         coalesce(c.object_key,  p.object_key),
         case when p.object_key is null then 'added'
              when c.object_key is null then 'removed'
              else 'changed' end
  from cur c full outer join prv p
    on p.object_kind = c.object_kind and p.object_key = c.object_key
  where p.object_key is null
     or c.object_key is null
     or c.fingerprint <> p.fingerprint
$fn$;

alter table public.engrep_catalog_snapshot enable row level security;
drop policy if exists engrep_cat_select on public.engrep_catalog_snapshot;
create policy engrep_cat_select on public.engrep_catalog_snapshot for select
using (public.engrep_is_adjudicator() or public.has_role(auth.uid(),'cto'));

select cron.unschedule('engrep-catalog-snapshot-1700-eat')
where exists (select 1 from cron.job where jobname='engrep-catalog-snapshot-1700-eat');

select cron.schedule(
  'engrep-catalog-snapshot-1700-eat',
  '0 14 * * *',
  $cj$ select public.engrep_capture_catalog(); $cj$
);
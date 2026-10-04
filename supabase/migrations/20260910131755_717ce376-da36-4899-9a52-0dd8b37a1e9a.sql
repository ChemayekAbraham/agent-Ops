alter table public.engrep_rows add column if not exists attribution text;

alter table public.engrep_rows drop constraint if exists engrep_rows_attribution;
alter table public.engrep_rows add constraint engrep_rows_attribution
  check (attribution is null or attribution in ('prefix','declared_path','email','none'));

create or replace function public.engrep_path_owner(p_paths text[], p_on date)
returns text
language sql
stable
security definer
set search_path to 'public','pg_temp'
as $function$
  with paths as (
    select p.path
    from unnest(coalesce(p_paths,'{}'::text[])) as p(path)
    where p.path is not null and btrim(p.path) <> ''
  ),
  owners as (
    select e.id, e.code, count(distinct pa.path) as covered
    from public.engrep_engineers e
    join public.engrep_fence_paths f on f.engineer_id = e.id
      and f.declared_from <= p_on
      and (f.declared_to is null or f.declared_to >= p_on)
    join paths pa on pa.path like f.path_pattern
    where e.active
    group by e.id, e.code
  )
  select o.code
  from owners o
  where (select count(*) from paths) > 0
    and o.covered = (select count(distinct path) from paths)
    and (
      select count(*) from owners o2
      where o2.covered = (select count(distinct path) from paths)
    ) = 1
$function$;

revoke all on function public.engrep_path_owner(text[], date) from public;
revoke all on function public.engrep_path_owner(text[], date) from anon;
grant execute on function public.engrep_path_owner(text[], date) to authenticated;
grant execute on function public.engrep_path_owner(text[], date) to service_role;
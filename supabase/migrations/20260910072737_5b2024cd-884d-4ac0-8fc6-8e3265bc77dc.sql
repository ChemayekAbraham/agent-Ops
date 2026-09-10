create table public.engrep_fence_paths (
  id            uuid primary key default gen_random_uuid(),
  engineer_id   uuid not null references public.engrep_engineers(id),
  path_pattern  text not null,
  declared_from date not null default (now() at time zone 'Africa/Kampala')::date,
  declared_to   date,
  declared_by   uuid not null,
  note          text,
  created_at    timestamptz not null default now(),
  constraint engrep_fence_order check (declared_to is null or declared_to >= declared_from),
  constraint engrep_fence_pattern check (char_length(btrim(path_pattern)) >= 4)
);

create index engrep_fence_active
  on public.engrep_fence_paths (engineer_id) where declared_to is null;

grant select, insert, update on public.engrep_fence_paths to authenticated;
grant all on public.engrep_fence_paths to service_role;

alter table public.engrep_fence_paths enable row level security;

create policy "engrep_fence_paths_select" on public.engrep_fence_paths
  for select to authenticated
  using ( public.engrep_is_adjudicator()
          or public.hr_is_engineering()
          or public.has_role(auth.uid(),'cto') );

create policy "engrep_fence_paths_insert" on public.engrep_fence_paths
  for insert to authenticated
  with check ( public.engrep_is_adjudicator() and declared_by = auth.uid() );

create policy "engrep_fence_paths_update" on public.engrep_fence_paths
  for update to authenticated
  using ( public.engrep_is_adjudicator() )
  with check ( public.engrep_is_adjudicator() );

create or replace function public.engrep_check_fence(
     p_engineer_code text, p_paths text[], p_on date)
   returns text
   language sql stable security definer
   set search_path to 'public','pg_temp'
as $$
  select f.path_pattern
  from public.engrep_fence_paths f
  join public.engrep_engineers owner on owner.id = f.engineer_id
  where owner.code <> upper(p_engineer_code)
    and f.declared_from <= p_on
    and (f.declared_to is null or f.declared_to >= p_on)
    and exists (
      select 1 from unnest(p_paths) as t(p)
      where t.p like f.path_pattern )
  order by f.path_pattern
  limit 1
$$;

revoke execute on function public.engrep_check_fence(text, text[], date) from anon;
grant execute on function public.engrep_check_fence(text, text[], date)
  to authenticated, service_role;
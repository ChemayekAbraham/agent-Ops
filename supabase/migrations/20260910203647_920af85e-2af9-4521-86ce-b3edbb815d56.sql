alter table public.engrep_rows
  add column if not exists recurrence_count integer not null default 0,
  add column if not exists recurrence_kind text;

alter table public.engrep_rows
  drop constraint if exists engrep_rows_recurrence_kind;
alter table public.engrep_rows
  add constraint engrep_rows_recurrence_kind
  check (recurrence_kind is null or recurrence_kind in ('object_retry','path_revisit'));

create index if not exists engrep_rows_paths_gin
  on public.engrep_rows using gin (paths);
create index if not exists engrep_rows_claimed_gin
  on public.engrep_rows using gin (claimed_objects);

create or replace function public.engrep_svc_resolve_lineage(p_window_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_status text;
  v_self_fix_count integer := 0;
  r record;
  v_has_retry boolean;
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
    select exists (
      select 1
      from public.engrep_rows p
      where p.engineer_id = r.engineer_id
        and p.id <> r.id
        and p.live_verified = 'no'
        and p.claimed_objects && r.claimed_objects
        and coalesce(p.committed_at, p.harvested_at)
              < coalesce(r.committed_at, r.harvested_at)
        and coalesce(p.committed_at, p.harvested_at)
              >= coalesce(r.committed_at, r.harvested_at) - interval '14 days'
    ) into v_has_retry;

    if v_has_retry then
      update public.engrep_rows
         set self_fix = true,
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

revoke all on function public.engrep_svc_resolve_lineage(uuid) from public;
revoke all on function public.engrep_svc_resolve_lineage(uuid) from anon;
revoke all on function public.engrep_svc_resolve_lineage(uuid) from authenticated;
grant execute on function public.engrep_svc_resolve_lineage(uuid) to service_role;

select cron.schedule(
  'engrep-resolve-lineage',
  '8 14 * * *',
  $$select public.engrep_svc_resolve_lineage(w.id)
    from public.engrep_windows w
    where w.granularity = 'day'
      and w.period_start = (now() at time zone 'Africa/Kampala')::date;$$
);
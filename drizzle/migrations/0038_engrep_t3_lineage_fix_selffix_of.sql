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
    v_self_fix_of := null;

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
            > coalesce(r.committed_at, r.harvested_at) - interval '14 days'
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
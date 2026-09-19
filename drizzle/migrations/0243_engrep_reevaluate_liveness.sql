create or replace function public.engrep_reevaluate_liveness(p_window date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed integer := 0;
begin
  with target as (
    select x.id,
           x.claimed_objects,
           w.period_end
      from public.engrep_rows x
      join public.engrep_windows w on w.id = x.window_id
     where w.period_start = p_window
       and x.claims_schema
       and x.live_verified in ('no', 'part')
  ),
  counted as (
    select t.id,
           coalesce(array_length(t.claimed_objects, 1), 0) as total,
           (
             select count(*)
               from unnest(coalesce(t.claimed_objects, '{}'::text[])) as co(obj)
              where exists (
                select 1
                  from public.engrep_catalog_movement m
                 where m.object_base = split_part(co.obj, '(', 1)
                   and m.moved_from_prev
                   and m.captured_for between (t.period_end - 2) and (t.period_end + 2)
              )
           ) as landed
      from target t
  ),
  upd as (
    update public.engrep_rows x
       set claims_landed = c.landed,
           live_verified = case
             when c.total > 0 and c.landed >= c.total then 'yes'
             when c.landed > 0 then 'part'
             else 'no'
           end
      from counted c
     where x.id = c.id
       and (
         x.claims_landed is distinct from c.landed
         or x.live_verified is distinct from case
              when c.total > 0 and c.landed >= c.total then 'yes'
              when c.landed > 0 then 'part'
              else 'no'
            end
       )
    returning 1
  )
  select count(*) into v_changed from upd;

  return v_changed;
end;
$$;

revoke all on function public.engrep_reevaluate_liveness(date) from public;
revoke all on function public.engrep_reevaluate_liveness(date) from anon;
revoke all on function public.engrep_reevaluate_liveness(date) from authenticated;
grant execute on function public.engrep_reevaluate_liveness(date) to service_role;
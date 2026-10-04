CREATE OR REPLACE FUNCTION public.engrep_reevaluate_liveness(p_window date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_changed integer := 0;
begin
  with target as (
    select x.id, x.claimed_objects, w.period_end
      from public.engrep_rows x
      join public.engrep_windows w on w.id = x.window_id
     where w.period_start = p_window
       and x.claims_schema
       and x.live_verified in ('no', 'part')
  ),
  objs as (
    select t.id, t.period_end, co.obj
      from target t
      cross join lateral unnest(coalesce(t.claimed_objects, '{}'::text[])) as co(obj)
     where not (co.obj ~ '^[A-Z]'
                or co.obj ~ '^tmp_'
                or lower(co.obj) in ('cannot','finance','engrep','public','select','insert',
                                     'update','delete','all','usage','execute','only'))
  ),
  counted as (
    select t.id,
           (select count(*) from objs o where o.id = t.id) as total,
           (select count(*) from objs o
             where o.id = t.id
               and exists (
                 select 1 from public.engrep_catalog_movement m
                  where (m.object_base = split_part(o.obj, '(', 1)
                         or m.object_base like '%.' || split_part(o.obj, '(', 1))
                    and m.moved_from_prev
                    and m.captured_for between (o.period_end - 2) and (o.period_end + 2))) as landed
      from target t
  ),
  scored as (
    select c.id, c.total, c.landed,
           (c.total > 0) as schema_claim,
           case when c.total = 0 then 'na'
                when c.landed >= c.total then 'yes'
                when c.landed > 0 then 'part'
                else 'no' end as lv
      from counted c
  ),
  upd as (
    update public.engrep_rows x
       set claims_schema = s.schema_claim,
           claims_total  = s.total,
           claims_landed = s.landed,
           live_verified = s.lv
      from scored s
     where x.id = s.id
       and (x.claims_schema is distinct from s.schema_claim
            or x.claims_total is distinct from s.total
            or x.claims_landed is distinct from s.landed
            or x.live_verified is distinct from s.lv)
    returning 1
  )
  select count(*) into v_changed from upd;
  return v_changed;
end;
$function$;
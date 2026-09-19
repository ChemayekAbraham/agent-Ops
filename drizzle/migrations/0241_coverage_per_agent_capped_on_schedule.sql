CREATE OR REPLACE FUNCTION public.get_agent_collections_coverage(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_d1 date;
  v_d2 date;
  v_today date;
  v_asof date;
  v_expected numeric := 0;
  v_result jsonb;
begin
  if not (
    has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
    or has_role(auth.uid(), 'ceo') or has_role(auth.uid(), 'coo')
    or has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'operations')
    or has_role(auth.uid(), 'agent_ops')
  ) then
    raise exception 'not authorized';
  end if;

  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'invalid range';
  end if;

  v_today := (now() at time zone 'Africa/Kampala')::date;
  v_d1    := (p_start at time zone 'Africa/Kampala')::date;
  v_d2    := ((p_end - interval '1 microsecond') at time zone 'Africa/Kampala')::date;
  v_asof  := least(v_d2, v_today);

  select coalesce(sum(p.expected_ugx), 0)
    into v_expected
  from public.agent_expected_day_plans p
  where p.day between v_d1 and v_asof;

  with bill as (
    select distinct p.rent_request_id
    from public.agent_expected_day_plans p
    where p.day between v_d1 and v_asof
  ),
  bill_amt as (
    select p.rent_request_id, sum(p.expected_ugx) as expected_ugx
    from public.agent_expected_day_plans p
    where p.day between v_d1 and v_asof
    group by p.rent_request_id
  ),
  cash as (
    select ac.agent_id, ac.rent_request_id, ac.amount
    from public.agent_collections ac
    where ac.created_at >= p_start
      and ac.created_at <  p_end
      and ac.amount > 0
      and ac.reversed_at is null
  ),
  split as (
    select
      coalesce(sum(c.amount), 0) as total,
      coalesce(sum(c.amount) filter (
        where exists (select 1 from bill b where b.rent_request_id = c.rent_request_id)
      ), 0) as on_schedule,
      coalesce(sum(c.amount) filter (
        where c.rent_request_id is not null
          and not exists (select 1 from bill b where b.rent_request_id = c.rent_request_id)
      ), 0) as arrears,
      coalesce(sum(c.amount) filter (where c.rent_request_id is null), 0) as unattributed
    from cash c
  ),
  rr_tot as (
    select rent_request_id, sum(amount) as paid
    from cash where rent_request_id is not null group by rent_request_id
  ),
  capped as (
    select coalesce(sum(least(coalesce(c.paid,0), b.expected_ugx)), 0) as on_schedule_capped,
           coalesce(sum(b.expected_ugx - least(coalesce(c.paid,0), b.expected_ugx)), 0) as pending_capped
    from bill_amt b
    left join rr_tot c on c.rent_request_id = b.rent_request_id
  ),
  agent_rr as (
    select agent_id, rent_request_id, sum(amount) as paid
    from cash where agent_id is not null and rent_request_id is not null
    group by agent_id, rent_request_id
  ),
  -- Per-agent share of the SAME capped figure the Home page reports: each
  -- rent request's capped amount split across the agents who collected it.
  per_agent_capped as (
    select ar.agent_id,
           coalesce(sum(least(rt.paid, b.expected_ugx) * ar.paid / nullif(rt.paid, 0)), 0) as capped
    from agent_rr ar
    join rr_tot rt on rt.rent_request_id = ar.rent_request_id
    join bill_amt b on b.rent_request_id = ar.rent_request_id
    group by ar.agent_id
  ),
  per_agent as (
    select c.agent_id,
      coalesce(sum(c.amount), 0) as collected,
      coalesce(sum(c.amount) filter (
        where exists (select 1 from bill b where b.rent_request_id = c.rent_request_id)
      ), 0) as collected_on_schedule
    from cash c
    where c.agent_id is not null
    group by c.agent_id
  )
  select jsonb_build_object(
    'range', jsonb_build_object('start', p_start, 'end', p_end),
    'expected_due', v_expected,
    'expected_basis', 'pinned_schedule',
    'expected_as_of', to_char(v_asof, 'YYYY-MM-DD'),
    'collected_total', s.total,
    'collected_on_schedule', s.on_schedule,
    'collected_arrears', s.arrears,
    'collected_unattributed', s.unattributed,
    'coverage_pct', case when v_expected > 0
                         then round(100.0 * s.on_schedule / v_expected, 1)
                         else null end,
    'collected_on_schedule_capped', (select on_schedule_capped from capped),
    'pending_capped', (select pending_capped from capped),
    'coverage_pct_capped', case when v_expected > 0
                             then round(100.0 * (select on_schedule_capped from capped) / v_expected, 1)
                             else null end,
    'coverage_basis', 'uncapped_on_billed_plans',
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'agent_id', a.agent_id,
        'collected', a.collected,
        'collected_on_schedule', a.collected_on_schedule,
        'collected_on_schedule_capped', round(coalesce(pc.capped, 0))
      ) order by a.collected_on_schedule desc)
      from per_agent a
      left join per_agent_capped pc on pc.agent_id = a.agent_id
    ), '[]'::jsonb),
    'generated_at', now()
  )
  into v_result
  from split s;

  return v_result;
end;
$function$;
create or replace function public.agent_ops_tenants_owing(p_as_of date default null)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_asof date := coalesce(p_as_of, (now() at time zone 'Africa/Kampala')::date);
  v_rows jsonb;
  v_tot jsonb;
begin
  if not (
    has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
    or has_role(auth.uid(), 'ceo') or has_role(auth.uid(), 'coo')
    or has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'operations')
    or has_role(auth.uid(), 'agent_ops')
  ) then
    raise exception 'not authorized';
  end if;

  with b as (
    select
      s.rent_request_id, s.tenant_id, s.agent_id,
      s.daily_amount, s.total_amount, s.amount_repaid,
      s.term_start, s.term_end, s.obligation_end,
      greatest(0, s.total_amount - s.amount_repaid) as outstanding,
      greatest(0,
        least(s.daily_amount * greatest(least(v_asof - s.term_start + 1, s.oblig_days), 0), s.total_amount)
        - s.amount_repaid
      ) as arrears,
      case when s.term_start <= v_asof and s.obligation_end >= v_asof
           then least(s.daily_amount * (v_asof - s.term_start + 1), s.total_amount)
              - least(s.daily_amount * (v_asof - s.term_start),     s.total_amount)
           else 0 end as scheduled_today,
      (s.term_start <= v_asof and s.obligation_end >= v_asof) as in_term,
      greatest(0, v_asof - s.obligation_end) as days_past_term
    from public.v_rent_plan_schedule s
  ),
  o as (select * from b where arrears > 0),
  lastpay as (
    select x.rent_request_id, max(x.d) as last_paid_on
    from (
      select ac.rent_request_id, (ac.created_at at time zone 'Africa/Kampala')::date as d
      from public.agent_collections ac where ac.rent_request_id is not null
      union all
      select rp.rent_request_id, (rp.created_at at time zone 'Africa/Kampala')::date
      from public.repayments rp where rp.rent_request_id is not null
    ) x
    group by x.rent_request_id
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'rent_request_id', o.rent_request_id,
      'tenant_id', o.tenant_id,
      'tenant_name', coalesce(tp.full_name, 'Unnamed tenant'),
      'tenant_phone', tp.phone,
      'agent_id', o.agent_id,
      'agent_name', coalesce(ap.full_name, 'Unassigned'),
      'agent_phone', ap.phone,
      'daily_amount', o.daily_amount,
      'scheduled_today', o.scheduled_today,
      'arrears', o.arrears,
      'outstanding', o.outstanding,
      'total_amount', o.total_amount,
      'amount_repaid', o.amount_repaid,
      'term_start', to_char(o.term_start, 'YYYY-MM-DD'),
      'term_end', to_char(o.term_end, 'YYYY-MM-DD'),
      'in_term', o.in_term,
      'days_past_term', o.days_past_term,
      'last_paid_on', to_char(lp.last_paid_on, 'YYYY-MM-DD')
    ) order by o.arrears desc), '[]'::jsonb)
  into v_rows
  from o
  left join profiles tp on tp.id = o.tenant_id
  left join profiles ap on ap.id = o.agent_id
  left join lastpay lp on lp.rent_request_id = o.rent_request_id;

  with b as (
    select
      greatest(0,
        least(s.daily_amount * greatest(least(v_asof - s.term_start + 1, s.oblig_days), 0), s.total_amount)
        - s.amount_repaid
      ) as arrears,
      greatest(0, s.total_amount - s.amount_repaid) as outstanding,
      s.daily_amount,
      case when s.term_start <= v_asof and s.obligation_end >= v_asof
           then least(s.daily_amount * (v_asof - s.term_start + 1), s.total_amount)
              - least(s.daily_amount * (v_asof - s.term_start),     s.total_amount)
           else 0 end as scheduled_today,
      (s.term_start <= v_asof and s.obligation_end >= v_asof) as in_term
    from public.v_rent_plan_schedule s
  ), o as (select * from b where arrears > 0)
  select jsonb_build_object(
    'tenants_owing', count(*),
    'total_arrears', coalesce(sum(arrears), 0),
    'total_outstanding', coalesce(sum(outstanding), 0),
    'scheduled_today', coalesce(sum(scheduled_today), 0),
    'owing_in_term', count(*) filter (where in_term),
    'owing_past_term', count(*) filter (where not in_term),
    'daily_rate_all_owing', coalesce(sum(daily_amount), 0),
    'daily_rate_past_term', coalesce(sum(daily_amount) filter (where not in_term), 0)
  )
  into v_tot
  from o;

  return jsonb_build_object(
    'as_of', to_char(v_asof, 'YYYY-MM-DD'),
    'timezone', 'Africa/Kampala',
    'totals', v_tot,
    'rows', v_rows,
    'generated_at', now()
  );
end;
$function$;
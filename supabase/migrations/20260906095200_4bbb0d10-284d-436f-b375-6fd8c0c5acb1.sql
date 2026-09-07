create or replace function public.agent_ops_dormant_agents_arrears(
  p_silent_days integer default 7,
  p_as_of date default null
)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_asof date := coalesce(p_as_of, (now() at time zone 'Africa/Kampala')::date);
  v_days integer := greatest(coalesce(p_silent_days, 7), 0);
  v_agents jsonb;
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

  with lastpay as (
    select x.rent_request_id, max(x.d) as last_paid_on
    from (
      select ac.rent_request_id, (ac.created_at at time zone 'Africa/Kampala')::date as d
      from public.agent_collections ac where ac.rent_request_id is not null
      union all
      select rp.rent_request_id, (rp.created_at at time zone 'Africa/Kampala')::date
      from public.repayments rp where rp.rent_request_id is not null
    ) x group by x.rent_request_id
  ), agent_last as (
    select ac.agent_id, max((ac.created_at at time zone 'Africa/Kampala')::date) as last_collection_on
    from public.agent_collections ac
    where ac.agent_id is not null
    group by ac.agent_id
  ), raw as (
    select s.agent_id, s.rent_request_id, s.tenant_id, s.daily_amount, s.term_start,
           s.obligation_end, s.total_amount, s.amount_repaid,
           greatest(0, s.total_amount - s.amount_repaid) as outstanding,
           greatest(0,
             least(s.daily_amount * greatest(least(v_asof - s.term_start + 1, s.oblig_days), 0), s.total_amount)
             - s.amount_repaid
           ) as arrears,
           greatest(0, v_asof - s.obligation_end) as days_past_term,
           lp.last_paid_on,
           al.last_collection_on,
           case when al.last_collection_on is null then null
                else (v_asof - al.last_collection_on) end as days_silent
    from public.v_rent_plan_schedule s
    left join lastpay lp on lp.rent_request_id = s.rent_request_id
    left join agent_last al on al.agent_id = s.agent_id
    where s.agent_id is not null
      and (al.last_collection_on is null or al.last_collection_on <= v_asof - v_days)
  ), base as (
    select r.*, tp.full_name as tenant_name, tp.phone as tenant_phone
    from raw r
    left join public.profiles tp on tp.id = r.tenant_id
    where r.arrears > 0
  ), per_agent as (
    select b.agent_id,
           coalesce(ap.full_name, 'Unnamed agent') as agent_name,
           ap.phone as agent_phone,
           max(b.last_collection_on) as last_collection_on,
           bool_and(b.last_collection_on is null) as never_collected,
           max(b.days_silent) as days_silent,
           count(*) as tenants_owing,
           sum(b.arrears) as arrears_ugx,
           sum(b.outstanding) as outstanding_ugx,
           jsonb_agg(jsonb_build_object(
             'rent_request_id', b.rent_request_id,
             'tenant_name', coalesce(b.tenant_name, 'Unnamed tenant'),
             'tenant_phone', b.tenant_phone,
             'daily_amount', b.daily_amount,
             'arrears', b.arrears,
             'outstanding', b.outstanding,
             'plan_total', b.total_amount,
             'repaid', b.amount_repaid,
             'term_start', to_char(b.term_start, 'YYYY-MM-DD'),
             'obligation_end', to_char(b.obligation_end, 'YYYY-MM-DD'),
             'days_past_term', b.days_past_term,
             'last_paid_on', to_char(b.last_paid_on, 'YYYY-MM-DD')
           ) order by b.arrears desc) as tenants
    from base b
    left join public.profiles ap on ap.id = b.agent_id
    group by b.agent_id, ap.full_name, ap.phone
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'agent_id', pa.agent_id,
      'agent_name', pa.agent_name,
      'agent_phone', pa.agent_phone,
      'last_collection_on', to_char(pa.last_collection_on, 'YYYY-MM-DD'),
      'never_collected', pa.never_collected,
      'days_silent', pa.days_silent,
      'tenants_owing', pa.tenants_owing,
      'arrears_ugx', pa.arrears_ugx,
      'outstanding_ugx', pa.outstanding_ugx,
      'tenants', pa.tenants
    ) order by pa.arrears_ugx desc), '[]'::jsonb),
    jsonb_build_object(
      'agents', count(*),
      'agents_never_collected', count(*) filter (where pa.never_collected),
      'tenants_owing', coalesce(sum(pa.tenants_owing), 0),
      'arrears_ugx', coalesce(sum(pa.arrears_ugx), 0),
      'outstanding_ugx', coalesce(sum(pa.outstanding_ugx), 0)
    )
  into v_agents, v_tot
  from per_agent pa;

  return jsonb_build_object(
    'as_of', to_char(v_asof, 'YYYY-MM-DD'),
    'silent_days', v_days,
    'timezone', 'Africa/Kampala',
    'totals', v_tot,
    'agents', v_agents,
    'generated_at', now()
  );
end;
$function$;
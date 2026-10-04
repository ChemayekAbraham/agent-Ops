create or replace function public.tppo_plan_arrears_detail(
  p_rent_request_id uuid,
  p_as_at date default null
)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_as_at date := coalesce(p_as_at, (now() at time zone 'Africa/Kampala')::date);
  v_plan record;
  v_tenant record;
  v_agent record;
  v_inflows jsonb;
  v_days jsonb;
  v_expected numeric := 0;
  v_arrears numeric := 0;
begin
  if not (
    has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
    or has_role(auth.uid(), 'ceo') or has_role(auth.uid(), 'coo')
    or has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'operations')
    or has_role(auth.uid(), 'agent_ops')
  ) then
    raise exception 'not authorized';
  end if;

  select s.rent_request_id, s.tenant_id, s.agent_id, s.daily_amount, s.total_amount,
         s.amount_repaid, s.term_start, s.obligation_end, s.oblig_days
    into v_plan
  from public.v_rent_plan_schedule s
  where s.rent_request_id = p_rent_request_id;

  if v_plan.rent_request_id is null then
    return jsonb_build_object('found', false);
  end if;

  v_expected := least(
    v_plan.daily_amount * greatest(least(v_as_at - v_plan.term_start + 1, v_plan.oblig_days), 0),
    v_plan.total_amount
  );
  v_arrears := greatest(0, v_expected - v_plan.amount_repaid);

  select p.full_name, p.phone, p.email, p.national_id, p.district, p.village, p.town,
         p.tenant_status, p.tenant_house_category, p.mobile_money_number, p.mobile_money_provider
    into v_tenant
  from public.profiles p where p.id = v_plan.tenant_id;

  select p.full_name, p.phone into v_agent
  from public.profiles p where p.id = v_plan.agent_id;

  -- Money actually received against this plan, newest first
  with receipts as (
    select ac.created_at, ac.amount, 'Agent collection'::text as source,
           coalesce(ac.collection_channel, ac.payment_method::text) as method,
           ac.tracking_id as reference,
           ap.full_name as recorded_by
    from public.agent_collections ac
    left join public.profiles ap on ap.id = ac.agent_id
    where ac.rent_request_id = p_rent_request_id
    union all
    select rp.created_at, rp.amount, 'Tenant payment'::text,
           rp.payment_method, rp.external_reference,
           pb.full_name
    from public.repayments rp
    left join public.profiles pb on pb.id = rp.paid_by
    where rp.rent_request_id = p_rent_request_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'paid_on', to_char((r.created_at at time zone 'Africa/Kampala')::date, 'YYYY-MM-DD'),
      'amount', r.amount,
      'source', r.source,
      'method', r.method,
      'reference', r.reference,
      'recorded_by', r.recorded_by
    ) order by r.created_at desc), '[]'::jsonb)
  into v_inflows
  from receipts r;

  -- Day-by-day schedule versus cash, so a shortfall day is visible
  with due as (
    select g.due_on, g.amount
    from public.rent_plan_schedule_days(v_plan.term_start, least(v_plan.obligation_end, v_as_at)) g
    where g.rent_request_id = p_rent_request_id
  ), paid as (
    select (created_at at time zone 'Africa/Kampala')::date as d, sum(amount) as amount
    from (
      select created_at, amount from public.agent_collections where rent_request_id = p_rent_request_id
      union all
      select created_at, amount from public.repayments where rent_request_id = p_rent_request_id
    ) x group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'due_on', to_char(d.due_on, 'YYYY-MM-DD'),
      'due_amount', d.amount,
      'paid_amount', coalesce(p.amount, 0),
      'shortfall', greatest(0, d.amount - coalesce(p.amount, 0))
    ) order by d.due_on desc), '[]'::jsonb)
  into v_days
  from due d
  left join paid p on p.d = d.due_on;

  return jsonb_build_object(
    'found', true,
    'as_at', to_char(v_as_at, 'YYYY-MM-DD'),
    'timezone', 'Africa/Kampala',
    'plan', jsonb_build_object(
      'rent_request_id', v_plan.rent_request_id,
      'daily_amount', v_plan.daily_amount,
      'plan_total', v_plan.total_amount,
      'repaid', v_plan.amount_repaid,
      'expected_to_date', v_expected,
      'arrears', v_arrears,
      'term_start', to_char(v_plan.term_start, 'YYYY-MM-DD'),
      'obligation_end', to_char(v_plan.obligation_end, 'YYYY-MM-DD'),
      'obligation_days', v_plan.oblig_days
    ),
    'tenant', jsonb_build_object(
      'name', coalesce(v_tenant.full_name, 'Unnamed tenant'),
      'phone', v_tenant.phone,
      'email', v_tenant.email,
      'national_id', v_tenant.national_id,
      'district', v_tenant.district,
      'village', v_tenant.village,
      'town', v_tenant.town,
      'status', v_tenant.tenant_status,
      'house_category', v_tenant.tenant_house_category,
      'mobile_money_number', v_tenant.mobile_money_number,
      'mobile_money_provider', v_tenant.mobile_money_provider
    ),
    'agent', jsonb_build_object(
      'name', coalesce(v_agent.full_name, 'Unassigned'),
      'phone', v_agent.phone
    ),
    'totals', jsonb_build_object(
      'receipt_count', coalesce(jsonb_array_length(v_inflows), 0),
      'received_total', coalesce((select sum((r->>'amount')::numeric) from jsonb_array_elements(v_inflows) r), 0),
      'due_days', coalesce(jsonb_array_length(v_days), 0),
      'shortfall_days', coalesce((select count(*) from jsonb_array_elements(v_days) r where (r->>'shortfall')::numeric > 0), 0)
    ),
    'inflows', v_inflows,
    'schedule_days', v_days,
    'generated_at', now()
  );
end;
$function$;

comment on function public.tppo_plan_arrears_detail(uuid, date) is
  'Drilldown behind one plan arrears figure: tenant and agent contact, plan facts, every receipt against the plan, and the day-by-day due versus paid ladder showing which dates fell short.';
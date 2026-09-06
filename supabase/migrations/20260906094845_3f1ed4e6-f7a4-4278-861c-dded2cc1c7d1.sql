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

  drop table if exists tmp_dormant;
  create temporary table tmp_dormant on commit drop as
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
  ), plans as (
    select s.agent_id, s.rent_request_id, s.tenant_id, s.daily_amount,
           s.term_start, s.obligation_end, s.total_amount, s.amount_repaid,
           greatest(0, s.total_amount - s.amount_repaid) as outstanding,
           greatest(0,
             least(s.daily_amount * greatest(least(v_asof - s.term_start + 1, s.oblig_days), 0), s.total_amount)
             - s.amount_repaid
           ) as arrears,
           greatest(0, v_asof - s.obligation_end) as days_past_term
    from public.v_rent_plan_schedule s
  )
  select p.agent_id, p.rent_request_id, p.tenant_id, p.daily_amount, p.term_start,
         p.obligation_end, p.total_amount, p.amount_repaid, p.outstanding, p.arrears,
         p.days_past_term, lp.last_paid_on,
         al.last_collection_on,
         case when al.last_collection_on is null then null
              else (v_asof - al.last_collection_on) end as days_silent
  from plans p
  left join lastpay lp on lp.rent_request_id = p.rent_request_id
  left join agent_last al on al.agent_id = p.agent_id
  where p.arrears > 0
    and p.agent_id is not null
    and (al.last_collection_on is null or al.last_collection_on <= v_asof - v_days);

  select coalesce(jsonb_agg(a order by a.arrears_ugx desc), '[]'::jsonb)
  into v_agents
  from (
    select jsonb_build_object(
      'agent_id', d.agent_id,
      'agent_name', coalesce(ap.full_name, 'Unnamed agent'),
      'agent_phone', ap.phone,
      'last_collection_on', to_char(max(d.last_collection_on), 'YYYY-MM-DD'),
      'never_collected', bool_and(d.last_collection_on is null),
      'days_silent', max(d.days_silent),
      'tenants_owing', count(*),
      'arrears_ugx', sum(d.arrears),
      'outstanding_ugx', sum(d.outstanding),
      'tenants', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'rent_request_id', t.rent_request_id,
          'tenant_name', coalesce(tp.full_name, 'Unnamed tenant'),
          'tenant_phone', tp.phone,
          'daily_amount', t.daily_amount,
          'arrears', t.arrears,
          'outstanding', t.outstanding,
          'plan_total', t.total_amount,
          'repaid', t.amount_repaid,
          'term_start', to_char(t.term_start, 'YYYY-MM-DD'),
          'obligation_end', to_char(t.obligation_end, 'YYYY-MM-DD'),
          'days_past_term', t.days_past_term,
          'last_paid_on', to_char(t.last_paid_on, 'YYYY-MM-DD')
        ) order by t.arrears desc), '[]'::jsonb)
        from tmp_dormant t
        left join profiles tp on tp.id = t.tenant_id
        where t.agent_id = d.agent_id
      )
    ) as a,
    sum(d.arrears) as arrears_ugx
    from tmp_dormant d
    left join profiles ap on ap.id = d.agent_id
    group by d.agent_id, ap.full_name, ap.phone
  ) a;

  select jsonb_build_object(
    'agents', count(distinct agent_id),
    'agents_never_collected', count(distinct agent_id) filter (where last_collection_on is null),
    'tenants_owing', count(*),
    'arrears_ugx', coalesce(sum(arrears), 0),
    'outstanding_ugx', coalesce(sum(outstanding), 0)
  ) into v_tot
  from tmp_dormant;

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

comment on function public.agent_ops_dormant_agents_arrears(integer, date) is
  'Agents holding tenants in arrears who have recorded no collection for at least p_silent_days, including agents who have never collected. Arrears derive from v_rent_plan_schedule so they honour repayment_starts_on, repayment_frequency and the obligation window. Returns per-agent totals with the full tenant-level arrears detail nested under each agent.';
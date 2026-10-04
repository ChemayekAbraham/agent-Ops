create or replace function public.tppo_arrears_movement(
  p_granularity text,
  p_anchor date default null
)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_anchor date := coalesce(p_anchor, (now() at time zone 'Africa/Kampala')::date);
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_cur_s date; v_cur_e date;
  v_p1_s date; v_p1_e date;
  v_p2_s date; v_p2_e date;
  v_step int;
  v_rows jsonb;
begin
  if not (
    has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
    or has_role(auth.uid(), 'ceo') or has_role(auth.uid(), 'coo')
    or has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'operations')
    or has_role(auth.uid(), 'agent_ops') or has_role(auth.uid(), 'tenant_ops')
  ) then
    raise exception 'not authorized';
  end if;

  if p_granularity not in ('day','week','month') then
    raise exception 'tppo_arrears_movement: unsupported granularity %', p_granularity;
  end if;

  select b.period_start, b.period_end into v_cur_s, v_cur_e
  from public.tppo_period_bounds(p_granularity, v_anchor) b;

  v_step := case p_granularity when 'day' then 1 when 'week' then 7 else 0 end;

  if p_granularity = 'month' then
    select b.period_start, b.period_end into v_p1_s, v_p1_e
    from public.tppo_period_bounds('month', (v_cur_s - interval '1 day')::date) b;
    select b.period_start, b.period_end into v_p2_s, v_p2_e
    from public.tppo_period_bounds('month', (v_p1_s - interval '1 day')::date) b;
  else
    select b.period_start, b.period_end into v_p1_s, v_p1_e
    from public.tppo_period_bounds(p_granularity, v_cur_s - v_step) b;
    select b.period_start, b.period_end into v_p2_s, v_p2_e
    from public.tppo_period_bounds(p_granularity, v_p1_s - v_step) b;
  end if;

  with periods(idx, ps, pe) as (
    values (0, v_p2_s, v_p2_e), (1, v_p1_s, v_p1_e), (2, v_cur_s, v_cur_e)
  ), scoped as (
    select idx, ps, pe, least(pe, v_today) as pe_eff from periods
  ), pay as (
    select ac.rent_request_id,
           (ac.created_at at time zone 'Africa/Kampala')::date as pd,
           ac.amount
    from public.agent_collections ac
    where ac.rent_request_id is not null
  ), plan_period as (
    select sc.idx, sc.ps, sc.pe, sc.pe_eff, s.rent_request_id,
      least(s.daily_amount * greatest(least(sc.pe_eff - s.term_start + 1, s.oblig_days), 0), s.total_amount) as sched_close,
      least(s.daily_amount * greatest(least(sc.ps - 1 - s.term_start + 1, s.oblig_days), 0), s.total_amount) as sched_open,
      greatest(0, s.amount_repaid - coalesce((select sum(p.amount) from pay p where p.rent_request_id = s.rent_request_id and p.pd > sc.pe_eff), 0)) as repaid_close,
      greatest(0, s.amount_repaid - coalesce((select sum(p.amount) from pay p where p.rent_request_id = s.rent_request_id and p.pd > sc.ps - 1), 0)) as repaid_open,
      coalesce((select sum(p.amount) from pay p where p.rent_request_id = s.rent_request_id and p.pd between sc.ps and sc.pe_eff), 0) as paid_in
    from scoped sc cross join public.v_rent_plan_schedule s
  ), derived as (
    select pp.*,
      greatest(0, pp.sched_open - pp.repaid_open) as opening,
      (pp.sched_close - pp.sched_open) as accrued,
      greatest(0, pp.repaid_open - pp.sched_open) as prepaid_credit,
      greatest(0, pp.sched_close - pp.repaid_close) as closing
    from plan_period pp
  ), final as (
    select d.*,
      least(d.accrued, d.prepaid_credit) as credit_used,
      least(d.paid_in, greatest(0, d.opening + d.accrued - least(d.accrued, d.prepaid_credit))) as cleared
    from derived d
  ), agg as (
    select idx, ps, pe, pe_eff,
      sum(opening) as opening_arrears,
      sum(accrued) as accrued,
      sum(credit_used) as prepaid_credit_absorbed,
      sum(cleared) as cleared_by_payment,
      sum(closing) as closing_arrears,
      sum(paid_in) as collected_in_period,
      sum(greatest(0, paid_in - cleared)) as paid_ahead_new,
      (sum(closing) - sum(opening)) as net_added_to_arrears,
      (sum(closing) - (sum(opening) + sum(accrued) - sum(credit_used) - sum(cleared))) as identity_residual,
      count(*) filter (where opening > 0) as plans_owing_open,
      count(*) filter (where closing > 0) as plans_owing_close,
      count(*) filter (where opening = 0 and closing > 0) as newly_in_arrears,
      count(*) filter (where opening > 0 and closing = 0) as fully_cleared
    from final group by idx, ps, pe, pe_eff
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'period_index', a.idx,
    'period_start', to_char(a.ps, 'YYYY-MM-DD'),
    'period_end', to_char(a.pe, 'YYYY-MM-DD'),
    'counted_through', to_char(a.pe_eff, 'YYYY-MM-DD'),
    'still_counting', (a.pe > v_today),
    'label', case p_granularity
               when 'day' then to_char(a.ps, 'DD Mon YYYY')
               when 'week' then 'Wk of ' || to_char(a.ps, 'DD Mon')
               else to_char(a.ps, 'Mon YYYY') end,
    'opening_arrears', a.opening_arrears,
    'accrued', a.accrued,
    'prepaid_credit_absorbed', a.prepaid_credit_absorbed,
    'cleared_by_payment', a.cleared_by_payment,
    'closing_arrears', a.closing_arrears,
    'net_added_to_arrears', a.net_added_to_arrears,
    'collected_in_period', a.collected_in_period,
    'paid_ahead_new', a.paid_ahead_new,
    'identity_residual', a.identity_residual,
    'plans_owing_open', a.plans_owing_open,
    'plans_owing_close', a.plans_owing_close,
    'newly_in_arrears', a.newly_in_arrears,
    'fully_cleared', a.fully_cleared
  ) order by a.idx), '[]'::jsonb)
  into v_rows
  from agg a;

  return jsonb_build_object(
    'granularity', p_granularity,
    'anchor', to_char(v_anchor, 'YYYY-MM-DD'),
    'today', to_char(v_today, 'YYYY-MM-DD'),
    'timezone', 'Africa/Kampala',
    'basis', 'live schedule arithmetic from v_rent_plan_schedule',
    'periods', v_rows,
    'generated_at', now()
  );
end;
$function$;

comment on function public.tppo_arrears_movement(text, date) is
  'Arrears movement for the anchored period and the two before it. Identity per period: opening + accrued - prepaid_credit_absorbed - cleared_by_payment = closing, and cleared_by_payment + paid_ahead_new = collected_in_period. identity_residual must be zero; a non-zero value means a balance moved by something other than a scheduled instalment or a recorded payment. Accrual is live schedule arithmetic and will NOT equal the pinned scheduled_due_ugx on tppo_period_snapshots, because the pin is frozen at first read of each day.';
-- Today's expected bill (agent_expected_day_plans) had two gaps:
--   1) pin_agent_expected_day() refused to do anything if ANY row already
--      existed for the day, so plans that became billable after the midnight
--      cron never got pinned. Now it always tops up (ON CONFLICT DO NOTHING).
--   2) Agents whose every plan is PAST its end date have no scheduled
--      instalment today, so expected = 0, coverage = 0 and the 50% gate locked
--      them out with "Collect UGX 0 more today". For those agents ONLY (no
--      scheduled row for the day at all) we now pin the daily instalment of
--      their still-owing past-term plans, capped at the outstanding balance.
--      Agents who do have a scheduled bill today are untouched.
create or replace function public.pin_agent_expected_day(p_day date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_rows int := 0; v_fallback int := 0;
begin
  if p_day is null or p_day > (now() at time zone 'Africa/Kampala')::date then
    return 0;
  end if;

  insert into public.agent_expected_day_plans (day, rent_request_id, agent_id, tenant_id, expected_ugx)
  select p_day, g.rent_request_id, s.agent_id, s.tenant_id, g.amount
  from public.rent_plan_schedule_days(p_day, p_day) g
  join public.v_rent_plan_schedule s on s.rent_request_id = g.rent_request_id
  on conflict (day, rent_request_id) do nothing;

  get diagnostics v_rows = row_count;

  -- Past-term fallback, scoped to agents with nothing scheduled for the day.
  with agents_with_bill as (
    select distinct agent_id
    from public.agent_expected_day_plans
    where day = p_day and agent_id is not null
  ), past_term as (
    select coalesce(rr.assigned_agent_id, rr.agent_id) as agent_id,
           rr.id as rent_request_id,
           rr.tenant_id,
           least(rr.daily_repayment,
                 coalesce(rr.total_repayment, 0) - coalesce(rr.amount_repaid, 0)) as expected_ugx
    from public.rent_requests rr
    where rr.status in ('funded', 'repaying')
      and coalesce(rr.agent_payment_status, 'paying') <> 'not_paying'
      and lower(coalesce(rr.repayment_frequency, 'daily')) <> 'weekly'
      and coalesce(rr.daily_repayment, 0) > 0
      and coalesce(rr.total_repayment, 0) - coalesce(rr.amount_repaid, 0) > 0
      and (coalesce(rr.repayment_starts_on, (rr.funded_at at time zone 'Africa/Kampala')::date)
           + coalesce(rr.duration_days, 0) - 1) < p_day
      and coalesce(rr.assigned_agent_id, rr.agent_id) is not null
      and not exists (
        select 1 from agents_with_bill a
        where a.agent_id = coalesce(rr.assigned_agent_id, rr.agent_id)
      )
  )
  insert into public.agent_expected_day_plans (day, rent_request_id, agent_id, tenant_id, expected_ugx)
  select p_day, pt.rent_request_id, pt.agent_id, pt.tenant_id, pt.expected_ugx
  from past_term pt
  where pt.expected_ugx > 0
  on conflict (day, rent_request_id) do nothing;

  get diagnostics v_fallback = row_count;

  return v_rows + v_fallback;
end;
$$;
-- Stop billing an overdue plan for more than it owes.
--
-- THE FAULT: once a plan's term has ended and the tenant still owes, pin_agent_expected_day adds one more day at the daily amount to the
-- agent's expected collections EVERY day, capped only against the total balance for that single day. It never counts the days already billed
-- and still unpaid. So a plan that owes 390,000 at 13,000 a day is billed 44 days = 572,000, and keeps growing. Those inflated "expected"
-- days feed agent_collection_rate_7d, so the agent's 7-day rate reads 0% and the 50% gates (landlord payouts, landlord float, CFO rent
-- disbursement) block them.
--
-- THE FIX, in two parts:
--   1. FROM NOW ON, for every agent: a new overdue day is only billed for what is still owed after the days already billed and unpaid.
--      pin_agent_expected_day is replaced by the same function with that one extra limit; nothing else in it changes.
--   2. EXISTING ROWS, for the agents listed in v_agents below (Kwenseri Rodgers only): the day rows that bill more than the balance owed are
--      trimmed or removed, oldest days kept first. Every changed row is copied to agent_expected_day_plans_backup_20261023 first.
--      The platform has 258 plans across 61 agents in the same position (about UGX 43.2M of excess). They are NOT changed here: it rewrites
--      their past expected figures, so add their ids to v_agents (or ask for the all-agents version) when you want that.
--
-- Not touched: frozen weekly performance snapshots (freeze_agent_weekly_performance, tppo_freeze_period) that already used these rows.
-- Needs the 20261023190000 balance corrections applied first (the cap uses each plan's balance owed today).
-- Roll back with 20261023210000_cap_overdue_plan_billing_at_balance_owed.rollback.sql.

-- 1. THE BILLING RULE ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pin_agent_expected_day(p_day date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare v_rows int := 0; v_fallback int := 0;
begin
  if p_day is null
     or p_day > (now() at time zone 'Africa/Kampala')::date
     or p_day < public.rent_arrears_go_live() then
    return 0;
  end if;

  insert into public.agent_expected_day_plans (day, rent_request_id, agent_id, tenant_id, expected_ugx)
  select p_day, g.rent_request_id, s.agent_id, s.tenant_id, g.amount
  from public.rent_plan_schedule_days(p_day, p_day) g
  join public.v_rent_plan_schedule s on s.rent_request_id = g.rent_request_id
  join public.rent_requests rr on rr.id = g.rent_request_id
  where rr.status = 'repaying'
    and p_day >= public.rent_plan_billable_from(rr.id)
  on conflict (day, rent_request_id) do nothing;

  get diagnostics v_rows = row_count;

  with agents_with_bill as (
    select distinct agent_id
    from public.agent_expected_day_plans
    where day = p_day and agent_id is not null
  ), already_billed as (
    -- Days already billed to this plan and still unpaid (before today's day).
    select ep.rent_request_id,
           sum(greatest(ep.expected_ugx - coalesce(st.amt, 0), 0)) as unpaid_billed
    from public.agent_expected_day_plans ep
    left join (select rds.rent_request_id, rds.day, sum(rds.amount) as amt
                 from public.rent_day_settlements rds group by rds.rent_request_id, rds.day) st
           on st.rent_request_id = ep.rent_request_id and st.day = ep.day
    where ep.day < p_day
    group by ep.rent_request_id
  ), past_term as (
    select coalesce(rr.assigned_agent_id, rr.agent_id) as agent_id,
           rr.id as rent_request_id,
           rr.tenant_id,
           least(rr.daily_repayment,
                 coalesce(rr.total_repayment, 0) - coalesce(rr.amount_repaid, 0) - coalesce(ab.unpaid_billed, 0)) as expected_ugx
    from public.rent_requests rr
    left join already_billed ab on ab.rent_request_id = rr.id
    where rr.status = 'repaying'
      and coalesce(rr.agent_payment_status, 'paying') <> 'not_paying'
      and lower(coalesce(rr.repayment_frequency, 'daily')) <> 'weekly'
      and coalesce(rr.daily_repayment, 0) > 0
      and coalesce(rr.total_repayment, 0) - coalesce(rr.amount_repaid, 0) > 0
      and p_day >= public.rent_plan_billable_from(rr.id)
      and (coalesce(rr.repayment_starts_on, (rr.funded_at at time zone 'Africa/Kampala')::date)
           + coalesce(rr.duration_days, 0) - 1) < p_day
      and coalesce(rr.assigned_agent_id, rr.agent_id) is not null
      and not exists (
        select 1
        from public.rent_repayment_pauses z
        where z.rent_request_id = rr.id
          and z.status = 'active'
          and z.resumed_at is null
          and (z.resume_on is null or z.resume_on >= p_day)
      )
      and (
        p_day >= public.agent_arrears_billing_go_live()
        or not exists (
          select 1 from agents_with_bill a
          where a.agent_id = coalesce(rr.assigned_agent_id, rr.agent_id)
        )
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
$function$;

-- 2. THE EXISTING ROWS (listed agents only) ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_expected_day_plans_backup_20261023 AS
  SELECT * FROM public.agent_expected_day_plans WHERE false;
ALTER TABLE public.agent_expected_day_plans_backup_20261023 ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.agent_expected_day_plans_backup_20261023 TO service_role;

DO $trim$
DECLARE
  v_agents uuid[] := ARRAY['da7dfe29-7091-4716-8ebc-9e1437e4711f']::uuid[];   -- Kwenseri Rodgers
  v_changed int; v_deleted int;
BEGIN
  CREATE TEMP TABLE _trim ON COMMIT DROP AS
  WITH plan_rows AS (
    SELECT ep.day, ep.rent_request_id, ep.expected_ugx, COALESCE(st.amt, 0) AS settled,
           GREATEST(COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0), 0) AS owed
      FROM public.agent_expected_day_plans ep
      JOIN public.rent_requests rr ON rr.id = ep.rent_request_id AND rr.status = 'repaying'
      LEFT JOIN (SELECT rent_request_id, day, sum(amount) AS amt FROM public.rent_day_settlements GROUP BY rent_request_id, day) st
             ON st.rent_request_id = ep.rent_request_id AND st.day = ep.day
     WHERE COALESCE(rr.assigned_agent_id, rr.agent_id) = ANY (v_agents)
       AND ep.day >= public.rent_arrears_go_live()
  ), run AS (
    SELECT pr.*, GREATEST(pr.expected_ugx - pr.settled, 0) AS rem,
           COALESCE(sum(GREATEST(pr.expected_ugx - pr.settled, 0)) OVER (PARTITION BY pr.rent_request_id ORDER BY pr.day
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS prior_rem
      FROM plan_rows pr
  )
  SELECT day, rent_request_id, settled,
         settled + LEAST(rem, GREATEST(owed - prior_rem, 0)) AS new_expected
    FROM run
   WHERE prior_rem + rem > owed;

  INSERT INTO public.agent_expected_day_plans_backup_20261023
    SELECT ep.* FROM public.agent_expected_day_plans ep JOIN _trim t ON t.rent_request_id = ep.rent_request_id AND t.day = ep.day;

  UPDATE public.agent_expected_day_plans ep SET expected_ugx = t.new_expected
    FROM _trim t WHERE t.rent_request_id = ep.rent_request_id AND t.day = ep.day AND t.new_expected > 0;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  DELETE FROM public.agent_expected_day_plans ep USING _trim t
   WHERE t.rent_request_id = ep.rent_request_id AND t.day = ep.day AND t.new_expected <= 0 AND t.settled = 0;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RAISE NOTICE 'Existing rows: % trimmed, % removed', v_changed, v_deleted;
END
$trim$;

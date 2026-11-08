-- Weekly Collection Streak: stop counting Rent Plans whose landlord has not been paid.
--
-- THE FAULT: a Rent Plan only starts billing once the landlord has been paid (pin_agent_expected_day bills status 'repaying' only; the
-- repaying gate holds a plan at 'funded' until the merchant payout lands). The Weekly Collection Streak does not follow that rule:
-- get_agent_weekly_collection_streak and _agent_week_active_days both treat every 'funded' plan as due from repayment_starts_on, which
-- defaults to funded_at + 1 day. So a plan that is funded but whose landlord payout was refused or is still waiting is "due" every day,
-- the tenant cannot be collected from (they were never housed on the company's money), and the agent loses a streak day.
-- process_weekly_streak_payouts reads _agent_week_active_days, so this is also real money: each missed day drops the weekly reward tier
-- (7/7 = 50,000, 6/7 = 30,000, 5/7 = 20,000, 4/7 = 10,000).
--
-- Seen on agent 5631cfe1-14b0-4ce2-9b9a-f7a808d3b12d (week of 2026-10-19): Charles Mugenyi and Edward Kabanda were funded on 2026-10-22 and
-- both landlord payouts were refused by the 50% landlord-payout gate. Friday 2026-10-23 showed 17/19 and went red because of those two.
--
-- THE FIX: a 'funded' plan counts toward the streak only when the landlord has been paid. This is the same test gate_repaying_on_merchant_
-- landlord_payout uses, including its exemptions, so the two rules cannot disagree:
--   * outstanding_balance plans (they carry no landlord payout),
--   * plans funded before the gate cutover 2026-09-24 06:22:48 UTC (49 are still 'funded'; they keep counting as they did),
--   * plans whose landlord payout was paid out by the merchant (rent_request_landlord_paid_by_merchant).
-- 'repaying' and 'completed' plans are untouched. Both functions are replaced by themselves plus that one condition.
--
-- Not touched: any Rent Plan row, any collection, agent_expected_day_plans, or streak rewards already credited for past weeks
-- (process_weekly_streak_payouts is idempotent per agent and week and is not re-run here). Neither function is in
-- critical_function_baselines (checked 2026-10-24), so there is no re-baseline.
-- Roll back with 20261024100000_streak_ignores_plans_whose_landlord_is_unpaid.rollback.sql.

CREATE OR REPLACE FUNCTION public._agent_week_active_days(p_agent uuid, p_week_start date)
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH days AS (
    SELECT d::date AS day FROM generate_series(p_week_start, p_week_start + 6, interval '1 day') d
  ), due AS (
    SELECT dd.day, rr.id AS rent_request_id, rr.tenant_id
    FROM days dd
    JOIN rent_requests rr
      ON COALESCE(rr.assigned_agent_id, rr.agent_id) = p_agent
     AND rr.status IN ('funded','repaying','completed')
     AND (rr.status <> 'funded'
          OR COALESCE(rr.registration_type, 'normal') = 'outstanding_balance'
          OR COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) < timestamptz '2026-09-24 06:22:48+00'
          OR public.rent_request_landlord_paid_by_merchant(rr.id))
     AND COALESCE(rr.agent_payment_status,'paying') <> 'not_paying'
     AND COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date) <= dd.day
     AND lower(COALESCE(rr.repayment_frequency,'daily')) <> 'weekly'
     AND (rr.status <> 'completed' OR EXISTS (
          SELECT 1 FROM agent_collections c WHERE c.rent_request_id = rr.id AND c.reversed_at IS NULL
            AND c.amount > 0 AND (c.created_at AT TIME ZONE 'Africa/Kampala')::date >= dd.day))
  ), paid AS (
    SELECT d.day, d.rent_request_id,
      EXISTS (SELECT 1 FROM agent_collections c
        WHERE c.reversed_at IS NULL AND c.amount > 0
          AND (c.created_at AT TIME ZONE 'Africa/Kampala')::date = d.day
          AND (c.rent_request_id = d.rent_request_id
               OR (c.rent_request_id IS NULL AND c.tenant_id = d.tenant_id))) AS ok
    FROM due d
  ), per_day AS (
    SELECT day, COUNT(*) AS due_n, COUNT(*) FILTER (WHERE ok) AS paid_n FROM paid GROUP BY day
  )
  SELECT COUNT(*)::int FROM per_day WHERE due_n > 0 AND paid_n = due_n;
$function$;

CREATE OR REPLACE FUNCTION public.get_agent_weekly_collection_streak(p_agent_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := COALESCE(p_agent_id, auth.uid());
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_week_start date := date_trunc('week', (now() AT TIME ZONE 'Africa/Kampala'))::date;
  v_days jsonb;
  v_active int;
  v_missed int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF v_agent <> auth.uid() AND NOT EXISTS (
    SELECT 1 FROM user_roles ur WHERE ur.user_id = auth.uid()
      AND ur.role IN ('agent_ops','manager','super_admin','coo','ceo','cfo')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  WITH days AS (
    SELECT d::date AS day FROM generate_series(v_week_start, v_week_start + 6, interval '1 day') d
  ), due AS (
    SELECT dd.day, rr.id AS rent_request_id, rr.tenant_id
    FROM days dd
    JOIN rent_requests rr
      ON COALESCE(rr.assigned_agent_id, rr.agent_id) = v_agent
     AND rr.status IN ('funded','repaying','completed')
     AND (rr.status <> 'funded'
          OR COALESCE(rr.registration_type, 'normal') = 'outstanding_balance'
          OR COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) < timestamptz '2026-09-24 06:22:48+00'
          OR public.rent_request_landlord_paid_by_merchant(rr.id))
     AND COALESCE(rr.agent_payment_status,'paying') <> 'not_paying'
     AND COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date) <= dd.day
     AND lower(COALESCE(rr.repayment_frequency,'daily')) <> 'weekly'
     AND (rr.status <> 'completed' OR EXISTS (
          SELECT 1 FROM agent_collections c WHERE c.rent_request_id = rr.id AND c.reversed_at IS NULL
            AND c.amount > 0 AND (c.created_at AT TIME ZONE 'Africa/Kampala')::date >= dd.day))
    WHERE dd.day <= v_today
  ), paid AS (
    SELECT d.day, d.rent_request_id,
      EXISTS (SELECT 1 FROM agent_collections c
        WHERE c.reversed_at IS NULL AND c.amount > 0
          AND (c.created_at AT TIME ZONE 'Africa/Kampala')::date = d.day
          AND (c.rent_request_id = d.rent_request_id
               OR (c.rent_request_id IS NULL AND c.tenant_id = d.tenant_id))) AS ok
    FROM due d
  ), per_day AS (
    SELECT dd.day,
      COUNT(p.rent_request_id) AS tenants_due,
      COUNT(p.rent_request_id) FILTER (WHERE p.ok) AS tenants_paid
    FROM days dd LEFT JOIN paid p ON p.day = dd.day
    GROUP BY dd.day
  )
  SELECT jsonb_agg(jsonb_build_object(
      'day', day, 'tenants_due', tenants_due, 'tenants_paid', tenants_paid,
      'state', CASE WHEN day > v_today THEN 'upcoming'
                    WHEN tenants_due > 0 AND tenants_paid = tenants_due THEN 'active'
                    WHEN day = v_today THEN 'in_progress'
                    ELSE 'missed' END) ORDER BY day),
    COUNT(*) FILTER (WHERE day <= v_today AND tenants_due > 0 AND tenants_paid = tenants_due),
    COUNT(*) FILTER (WHERE day < v_today AND NOT (tenants_due > 0 AND tenants_paid = tenants_due))
  INTO v_days, v_active, v_missed
  FROM per_day;

  RETURN jsonb_build_object(
    'week_start', v_week_start, 'week_end', v_week_start + 6, 'today', v_today,
    'active_days', v_active, 'missed_days', v_missed,
    'best_possible_active', 7 - v_missed,
    'days', v_days,
    'payouts_enabled', true);
END $function$;

-- CREATE OR REPLACE keeps the existing grants; nothing to re-grant.

-- Rollback for 20261029140000_agent_daily_eligibility_set_based.sql
-- Restores the per-plan expected helper and the view-backed eligibility RPC,
-- then drops the scoped function and the two indexes. The app's 25-id batches
-- still return the same rows after this; each call is slow again.

CREATE OR REPLACE FUNCTION public._agent_expected_effective__impl(p_agent_ids uuid[], p_from date, p_to date)
RETURNS TABLE(day date, agent_id uuid, rent_request_id uuid, tenant_id uuid, expected_ugx numeric, is_normal_day boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH weeks AS (
    SELECT DISTINCT public._agent_rule_week_start(g::date) AS lo
    FROM generate_series(p_from, p_to, interval '1 day') g
  ), cand AS (
    SELECT wk.lo,
           COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
           rr.id AS rent_request_id,
           rr.tenant_id,
           rr.daily_repayment AS daily,
           GREATEST(wk.lo, public.rent_plan_billable_from(rr.id), public.agent_arrears_billing_go_live()) AS s0,
           GREATEST(COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0)
                    + COALESCE((SELECT sum(ac.amount) FROM public.agent_collections ac
                                WHERE ac.rent_request_id = rr.id AND ac.reversed_at IS NULL AND ac.amount > 0
                                  AND ac.created_at >= (wk.lo::timestamp AT TIME ZONE 'Africa/Kampala')), 0),
                    0) AS owed_at_start
    FROM weeks wk
    CROSS JOIN public.rent_requests rr
    WHERE rr.status = 'repaying'
      AND COALESCE(rr.agent_payment_status, 'paying') <> 'not_paying'
      AND lower(COALESCE(rr.repayment_frequency, 'daily')) <> 'weekly'
      AND COALESCE(rr.daily_repayment, 0) > 0
      AND COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0) > 0
      AND COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date)
            + COALESCE(rr.duration_days, 0) - 1 < wk.lo
      AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
      AND (p_agent_ids IS NULL OR COALESCE(rr.assigned_agent_id, rr.agent_id) = ANY (p_agent_ids))
      AND EXISTS (SELECT 1 FROM public.agent_expected_day_plans e0 WHERE e0.rent_request_id = rr.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.rent_repayment_pauses z
        WHERE z.rent_request_id = rr.id AND z.status = 'active' AND z.resumed_at IS NULL
          AND (z.resume_on IS NULL OR z.resume_on >= LEAST(wk.lo + 6, p_to)))
  ), normal_days AS (
    SELECT c.agent_id, c.rent_request_id, c.tenant_id, g::date AS day,
           LEAST(c.daily, GREATEST(c.owed_at_start - c.daily * (row_number() OVER (PARTITION BY c.lo, c.rent_request_id ORDER BY g) - 1), 0)) AS amount
    FROM cand c
    CROSS JOIN LATERAL generate_series(c.s0, LEAST(c.lo + 6, p_to), interval '1 day') g
  ), pins AS (
    SELECT e.day, e.agent_id, e.rent_request_id, e.tenant_id, e.expected_ugx
    FROM public.agent_expected_day_plans e
    WHERE e.day BETWEEN p_from AND p_to
      AND e.agent_id IS NOT NULL
      AND e.expected_ugx > 0
      AND (p_agent_ids IS NULL OR e.agent_id = ANY (p_agent_ids))
  )
  SELECT COALESCE(p.day, n.day),
         COALESCE(p.agent_id, n.agent_id),
         COALESCE(p.rent_request_id, n.rent_request_id),
         COALESCE(p.tenant_id, n.tenant_id),
         GREATEST(COALESCE(p.expected_ugx, 0), COALESCE(n.amount, 0)),
         COALESCE(n.amount, 0) > COALESCE(p.expected_ugx, 0)
  FROM pins p
  FULL JOIN (SELECT * FROM normal_days WHERE day >= p_from AND amount > 0) n
    ON n.day = p.day AND n.rent_request_id = p.rent_request_id AND n.agent_id = p.agent_id;
$function$;

CREATE OR REPLACE FUNCTION public.get_agent_daily_eligibility__impl(p_agent_ids uuid[])
RETURNS TABLE(
  agent_id uuid,
  active_count integer,
  expected_daily numeric,
  paid_today numeric,
  paid_yesterday numeric,
  today_pct numeric,
  yesterday_pct numeric,
  effective_pct numeric,
  raw_today_pct numeric,
  raw_yesterday_pct numeric,
  tenants_due integer,
  tenants_paid_today integer,
  tenants_paid_yesterday integer,
  coverage_today numeric,
  coverage_yesterday numeric,
  effective_coverage numeric,
  weekly_plan_count integer,
  weekly_lapsed_count integer,
  weekly_expected_week numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT v.agent_id, v.active_count, v.expected_daily,
         v.paid_today, v.paid_yesterday,
         v.today_pct, v.yesterday_pct, v.effective_pct,
         v.raw_today_pct, v.raw_yesterday_pct,
         v.tenants_due, v.tenants_paid_today, v.tenants_paid_yesterday,
         v.coverage_today, v.coverage_yesterday, v.effective_coverage,
         v.weekly_plan_count, v.weekly_lapsed_count, v.weekly_expected_week
  FROM public.v_agent_daily_eligibility v
  WHERE v.agent_id = ANY (p_agent_ids);
$function$;

DROP FUNCTION IF EXISTS public._agent_daily_eligibility_for(uuid[]);

DROP INDEX IF EXISTS public.idx_agent_collections_rent_request_live_created;
DROP INDEX IF EXISTS public.idx_landlord_payouts_rent_request_id;

REVOKE ALL ON FUNCTION public._agent_expected_effective__impl(uuid[], date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_expected_effective__impl(uuid[], date, date) TO service_role;

REVOKE ALL ON FUNCTION public.get_agent_daily_eligibility__impl(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_daily_eligibility__impl(uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.get_agent_daily_eligibility(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_agent_daily_eligibility(uuid[]) TO authenticated, service_role;

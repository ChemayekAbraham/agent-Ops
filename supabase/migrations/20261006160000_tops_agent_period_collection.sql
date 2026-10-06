-- Tenant Ops workspace: per-agent PERIOD collection figures, worked out exactly the way Tenant Ops Home does.
-- Additive, read-only. Nothing existing is changed.
--
-- Why: the Management Overview tab's agent table is built from get_tenant_topup_eligibility, whose money figures are
-- ALL-TIME per Rent Plan (rent_requests.total_repayment / amount_repaid) and "arrears to date" from calendar days
-- since the plan started. Users read them next to Home's period figures. This report gives the matching PERIOD
-- figures per agent so the two can sit side by side.
--
-- tops_agent_period_collection(p_start, p_end, p_agent_id default null) returns jsonb:
--   window    start_day, end_day, asof (the earlier of the last day and today, Kampala), days
--   totals    expected_ugx, collected_ugx, short_ugx, coverage_pct, paid_ahead_ugx (split: no_bill, above_bill), plans_billed
--   rows[]    one per agent (null agent = "No agent"): agent_id, agent_name, expected_ugx, collected_ugx, short_ugx,
--             coverage_pct, plans_billed, paid_ahead_ugx, paid_ahead_plans
--
-- The Home rule (ops_tenant_ops_home_range), copied:
--   * Kampala days. Expected = sum of agent_expected_day_plans.expected_ugx from the first day of the period to the
--     earlier of the period's last day and today.
--   * Collected = per Rent Plan, the smaller of (a) what was paid in the window (agent_collections, amount > 0,
--     reversed_at IS NULL, i.e. cancelled payments excluded) and (b) that plan's billed amount.
--   * Short = Expected - Collected (Home's "pending").
--   * Money above the bill, and payments on plans with no bill in the period, are NOT collected; they are returned
--     separately as paid ahead.
-- An agent is the Rent Plan's current agent (rent_requests.agent_id, the same agent the Management Overview rows use),
-- falling back to the agent pinned on the bill. Plans are not limited to a tenant's latest plan, because Home is not.
-- Summed over all agents, expected and collected equal ops_tenant_ops_home_range for the same dates.
--
-- Role check: copied from get_tenant_topup_eligibility (the report the Management Overview is built on), which also
-- admits cfo. No anon grant.

CREATE OR REPLACE FUNCTION public.tops_agent_period_collection(
  p_start timestamptz,
  p_end timestamptz,
  p_agent_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_d1 date;
  v_d2 date;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_asof date;
  v_result jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  v_start := (date_trunc('day', (p_start AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala');
  v_end := (date_trunc('day', (p_end AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala') + interval '1 day';
  v_d1 := (v_start AT TIME ZONE 'Africa/Kampala')::date;
  v_d2 := ((v_end - interval '1 microsecond') AT TIME ZONE 'Africa/Kampala')::date;
  v_asof := LEAST(v_d2, v_today);

  WITH bill AS (
    SELECT dp.rent_request_id AS b_rr,
           SUM(dp.expected_ugx) AS b_ugx,
           (array_agg(dp.agent_id ORDER BY dp.day DESC))[1] AS b_agent
    FROM public.agent_expected_day_plans dp
    WHERE dp.day BETWEEN v_d1 AND v_asof
    GROUP BY dp.rent_request_id
  ),
  cash AS (
    SELECT ac.rent_request_id AS c_rr, SUM(ac.amount) AS c_ugx
    FROM public.agent_collections ac
    WHERE ac.created_at >= v_start AND ac.created_at < v_end
      AND ac.amount > 0 AND ac.reversed_at IS NULL
      AND ac.rent_request_id IS NOT NULL
    GROUP BY ac.rent_request_id
  ),
  plans AS (
    SELECT COALESCE(b.b_rr, c.c_rr) AS p_rr,
           COALESCE(b.b_ugx, 0) AS billed,
           COALESCE(c.c_ugx, 0) AS paid,
           b.b_agent
    FROM bill b
    FULL JOIN cash c ON c.c_rr = b.b_rr
  ),
  per AS (
    SELECT pl.p_rr,
           COALESCE(rr.agent_id, pl.b_agent) AS ag,
           pl.billed,
           LEAST(pl.paid, pl.billed) AS counted,
           pl.paid - LEAST(pl.paid, pl.billed) AS ahead,
           (pl.billed <> 0) AS has_bill
    FROM plans pl
    LEFT JOIN public.rent_requests rr ON rr.id = pl.p_rr
  ),
  chosen AS (
    SELECT * FROM per x WHERE p_agent_id IS NULL OR x.ag = p_agent_id
  ),
  by_agent AS (
    SELECT c.ag,
           SUM(c.billed) AS expected,
           SUM(c.counted) AS collected,
           SUM(c.ahead) AS ahead,
           count(*) FILTER (WHERE c.has_bill)::int AS plans_billed,
           count(*) FILTER (WHERE c.ahead > 0)::int AS ahead_plans
    FROM chosen c
    GROUP BY c.ag
  ),
  tot AS (
    SELECT COALESCE(SUM(c.billed), 0) AS expected,
           COALESCE(SUM(c.counted), 0) AS collected,
           COALESCE(SUM(c.ahead), 0) AS ahead,
           COALESCE(SUM(c.ahead) FILTER (WHERE NOT c.has_bill), 0) AS ahead_no_bill,
           COALESCE(SUM(c.ahead) FILTER (WHERE c.has_bill), 0) AS ahead_above_bill,
           count(*) FILTER (WHERE c.has_bill)::int AS plans_billed
    FROM chosen c
  )
  SELECT jsonb_build_object(
    'window', jsonb_build_object('start_day', v_d1, 'end_day', v_d2, 'asof', v_asof, 'days', (v_d2 - v_d1) + 1),
    'basis', 'Same rule as Tenant Ops Home: Kampala days, bill up to today, payments limited to each Rent Plan''s bill, cancelled payments excluded; money above the bill is shown as paid ahead and is not collected.',
    'totals', (SELECT jsonb_build_object(
        'expected_ugx', t.expected, 'collected_ugx', t.collected, 'short_ugx', t.expected - t.collected,
        'coverage_pct', round(t.collected / NULLIF(t.expected, 0) * 100, 1),
        'paid_ahead_ugx', t.ahead, 'paid_ahead_no_bill_ugx', t.ahead_no_bill, 'paid_ahead_above_bill_ugx', t.ahead_above_bill,
        'plans_billed', t.plans_billed) FROM tot t),
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'agent_id', a.ag,
        'agent_name', COALESCE(NULLIF(trim(pr.full_name), ''), CASE WHEN a.ag IS NULL THEN 'No agent' ELSE 'Unnamed agent' END),
        'expected_ugx', a.expected, 'collected_ugx', a.collected, 'short_ugx', a.expected - a.collected,
        'coverage_pct', round(a.collected / NULLIF(a.expected, 0) * 100, 1),
        'plans_billed', a.plans_billed,
        'paid_ahead_ugx', a.ahead, 'paid_ahead_plans', a.ahead_plans
      ) ORDER BY a.expected DESC, a.ag)
      FROM by_agent a LEFT JOIN public.profiles pr ON pr.id = a.ag), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_agent_period_collection(timestamptz, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_agent_period_collection(timestamptz, timestamptz, uuid) TO authenticated;

-- ============================================================================
-- P2 #11 — Executive weekly metrics: ONE central data layer
-- ============================================================================
-- Management wants department numbers to come from the system, not from the
-- department head. Four public RPCs, all backed by one internal engine:
--
--   get_tenant_ops_weekly_metrics()
--   get_agent_ops_weekly_metrics()
--   get_partner_ops_weekly_metrics()
--   get_landlord_ops_weekly_metrics()
--
-- Every row is one metric: current value, value 7 days ago, net change,
-- % change, and a 7-day projection. Dashboards consume these; nothing
-- recalculates independently.
--
-- Two kinds of metric:
--   stock — a point-in-time level (e.g. active Rent Plans). "7 days ago" is
--           either RECONSTRUCTED exactly from immutable timestamps (created_at,
--           verified_at, funded_at, first-seen) or, where the source table has
--           no history (plan closure, balances), read from the hourly
--           exec_ops_metric_snapshots table. Until a snapshot 7 days old
--           exists the week-ago value is NULL with source 'no_snapshot_yet'
--           — never a guess.
--   flow  — an amount over a window. current = last 7x24h, week-ago = the 7x24h
--           before that. Pinned-bill metrics (expected / collected on schedule)
--           use the last 7 COMPLETE Kampala days instead, because the bill is
--           per Kampala day (see welile-expected-vs-collected skill).
--
-- Projection (7 days ahead):
--   stock → straight-line continuation, GREATEST(0, current + net_change),
--           method 'linear_wow' (NULL/'unavailable' until a week-ago exists).
--   flow  → run-rate: next 7 days = last 7 days, method 'run_rate_7d'.
--           Trend-extrapolating a weekly flow is fragile: one burst day in the
--           prior window (e.g. agent collections 2026-09-16: UGX 52.9M vs a
--           ~3M/day norm) would project the next week to zero.
--   Exception — rent expected:scheduled repayments for the next 7 days (rent_plan_schedule_days)
-- plus 7 x yesterday's past-term fallback bill, method 'schedule_plus_past_term'.
--
-- Definitions are deliberately reused, not reinvented:
--   * agent = get_agent_ops_overview baseline (2026-09-02): collected rent, or
--     acting agent on a rent request that is not their own.
--   * commission = same net wallet categories as get_agent_ops_overview.
--   * live Rent Plan = status funded/repaying/disbursed/active, tenancy not ended
--     (same filter as get_agent_ops_overview.pending_collections).
--   * collections exclude reversed_at IS NOT NULL.
--   * Returns distributed = platform roi_expense cash_out (= wallet credit +
--     reinvestment).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Snapshot store (hourly), so stocks without history still get a week-ago
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.exec_ops_metric_snapshots (
  domain       text        NOT NULL CHECK (domain IN ('tenant','agent','partner','landlord')),
  metric_key   text        NOT NULL,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  value        numeric     NOT NULL,
  PRIMARY KEY (domain, metric_key, captured_at)
);

CREATE INDEX IF NOT EXISTS idx_exec_ops_metric_snapshots_lookup
  ON public.exec_ops_metric_snapshots (domain, metric_key, captured_at DESC);

ALTER TABLE public.exec_ops_metric_snapshots ENABLE ROW LEVEL SECURITY;
-- No policies: read only through the SECURITY DEFINER functions below.
REVOKE ALL ON public.exec_ops_metric_snapshots FROM anon, authenticated;

COMMENT ON TABLE public.exec_ops_metric_snapshots IS
  'Hourly point-in-time values of executive weekly stock metrics. Written only by capture_exec_ops_metric_snapshots(); read by get_*_ops_weekly_metrics() for the week-ago value of stocks that have no history in their source table.';

-- ---------------------------------------------------------------------------
-- 2. Raw metric engine (internal — not callable by clients)
-- ---------------------------------------------------------------------------
-- prior_value/prior_basis:
--   'reconstructed' — exact value at p_as_of - 7 days
--   'prior_window'  — flow over the preceding window
--   'snapshot'      — prior_value is NULL here; the caller reads the snapshot
CREATE OR REPLACE FUNCTION public._exec_ops_metrics_raw(
  p_domain      text,
  p_as_of       timestamptz DEFAULT now(),
  p_stocks_only boolean     DEFAULT false
)
RETURNS TABLE (
  sort_order          int,
  metric_key          text,
  label               text,
  unit                text,
  metric_kind         text,
  current_value       numeric,
  prior_value         numeric,
  prior_basis         text,
  projection_override numeric,
  basis               text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  t1  timestamptz := p_as_of;                  -- window end (exclusive)
  t0  timestamptz := p_as_of - interval '7 days'; -- window start / week-ago point
  tp  timestamptz := p_as_of - interval '14 days';-- prior window start
  v_today date := (p_as_of AT TIME ZONE 'Africa/Kampala')::date;
  -- complete Kampala days: current = today-7 .. today-1, prior = today-14 .. today-8
  d_c0 date := v_today - 7;
  d_c1 date := v_today - 1;
  d_p0 date := v_today - 14;
  d_p1 date := v_today - 8;
  v_live_status text[] := ARRAY['funded','repaying','disbursed','active'];
  v_rolling  text := 'Rolling 7x24h window ending as_of; week-ago = the 7x24h before it';
  v_complete text := 'Last 7 complete Africa/Kampala days (pinned daily bill); week-ago = the 7 days before';
BEGIN
  -- =========================================================================
  IF p_domain = 'tenant' THEN
  -- =========================================================================
    RETURN QUERY
    WITH live AS (
      SELECT rr.tenant_id,
             GREATEST(COALESCE(rr.total_repayment,0) - COALESCE(rr.amount_repaid,0), 0) AS bal
        FROM rent_requests rr
       WHERE rr.status = ANY (v_live_status)
         AND COALESCE(rr.tenancy_status,'active') <> 'ended'
    )
    SELECT 10, 'active_rent_plans', 'Active Rent Plans', 'count', 'stock',
           (SELECT count(*)::numeric FROM live), NULL::numeric, 'snapshot', NULL::numeric,
           'Rent Plans funded/repaying/disbursed/active with tenancy not ended'
    UNION ALL
    SELECT 20, 'tenants_on_active_plan', 'Tenants on an active Rent Plan', 'count', 'stock',
           (SELECT count(DISTINCT tenant_id)::numeric FROM live), NULL, 'snapshot', NULL,
           'Distinct tenants holding at least one active Rent Plan'
    UNION ALL
    SELECT 30, 'rent_plan_balance_outstanding', 'Outstanding Rent Plan balance', 'ugx', 'stock',
           (SELECT COALESCE(sum(bal),0) FROM live), NULL, 'snapshot', NULL,
           'Sum of total_repayment - amount_repaid (floored at 0) over active Rent Plans'
    UNION ALL
    SELECT 40, 'tenants_ever_funded', 'Tenants ever funded', 'count', 'stock',
           (SELECT count(DISTINCT tenant_id)::numeric FROM rent_requests WHERE funded_at < t1),
           (SELECT count(DISTINCT tenant_id)::numeric FROM rent_requests WHERE funded_at < t0),
           'reconstructed', NULL,
           'Distinct tenants with a funded_at before the point in time';

    IF p_stocks_only THEN RETURN; END IF;

    RETURN QUERY
    SELECT 50, 'rent_requests_submitted', 'Rent requests submitted', 'count', 'flow',
           (SELECT count(*)::numeric FROM rent_requests WHERE created_at >= t0 AND created_at < t1),
           (SELECT count(*)::numeric FROM rent_requests WHERE created_at >= tp AND created_at < t0),
           'prior_window', NULL::numeric, v_rolling
    UNION ALL
    SELECT 60, 'rent_plans_funded', 'Rent Plans funded', 'count', 'flow',
           (SELECT count(*)::numeric FROM rent_requests WHERE funded_at >= t0 AND funded_at < t1),
           (SELECT count(*)::numeric FROM rent_requests WHERE funded_at >= tp AND funded_at < t0),
           'prior_window', NULL, v_rolling
    UNION ALL
    SELECT 70, 'rent_funded_ugx', 'Rent funded', 'ugx', 'flow',
           (SELECT COALESCE(sum(rent_amount),0) FROM rent_requests WHERE funded_at >= t0 AND funded_at < t1),
           (SELECT COALESCE(sum(rent_amount),0) FROM rent_requests WHERE funded_at >= tp AND funded_at < t0),
           'prior_window', NULL, v_rolling
    UNION ALL
    SELECT 80, 'rent_collected_ugx', 'Rent collected (all cash in)', 'ugx', 'flow',
           (SELECT COALESCE(sum(amount),0) FROM agent_collections
             WHERE reversed_at IS NULL AND amount > 0 AND created_at >= t0 AND created_at < t1),
           (SELECT COALESCE(sum(amount),0) FROM agent_collections
             WHERE reversed_at IS NULL AND amount > 0 AND created_at >= tp AND created_at < t0),
           'prior_window', NULL,
           v_rolling || '. agent_collections, reversals excluded; includes arrears — NOT the numerator for rent_expected_ugx'
    UNION ALL
    SELECT 90, 'tenants_paid', 'Tenants who paid', 'count', 'flow',
           (SELECT count(DISTINCT tenant_id)::numeric FROM agent_collections
             WHERE reversed_at IS NULL AND amount > 0 AND created_at >= t0 AND created_at < t1),
           (SELECT count(DISTINCT tenant_id)::numeric FROM agent_collections
             WHERE reversed_at IS NULL AND amount > 0 AND created_at >= tp AND created_at < t0),
           'prior_window', NULL, v_rolling;

    -- Pinned bill vs collected against that bill (per plan per day, capped).
    RETURN QUERY
    WITH bill AS (
      SELECT b.day, b.rent_request_id, b.expected_ugx
        FROM agent_expected_day_plans b
       WHERE b.day BETWEEN d_p0 AND d_c1
    ), paid AS (
      SELECT (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
             ac.rent_request_id, sum(ac.amount) AS paid
        FROM agent_collections ac
       WHERE ac.reversed_at IS NULL
         AND ac.rent_request_id IS NOT NULL
         AND ac.created_at >= (d_p0::timestamp AT TIME ZONE 'Africa/Kampala')
         AND ac.created_at <  ((d_c1 + 1)::timestamp AT TIME ZONE 'Africa/Kampala')
       GROUP BY 1, 2
    ), j AS (
      SELECT bill.day, bill.expected_ugx,
             LEAST(COALESCE(paid.paid,0), bill.expected_ugx) AS on_sched
        FROM bill LEFT JOIN paid USING (day, rent_request_id)
    ), fwd AS (
      SELECT COALESCE(sum(s.amount),0) AS amt
        FROM rent_plan_schedule_days(v_today, v_today + 6) s
    ), fallback AS (
      -- pin_agent_expected_day also bills past-term plans that still owe
      -- (its "past-term fallback"), which rent_plan_schedule_days does not
      -- contain. Carry yesterday's fallback forward as a daily run-rate so the
      -- projection is on the same basis as the pinned bill it is compared to.
      SELECT COALESCE(sum(b.expected_ugx),0) AS amt
        FROM agent_expected_day_plans b
        LEFT JOIN rent_plan_schedule_days(d_c1, d_c1) s ON s.rent_request_id = b.rent_request_id
       WHERE b.day = d_c1 AND s.rent_request_id IS NULL
    )
    SELECT 100, 'rent_expected_ugx', 'Rent expected (pinned bill)', 'ugx', 'flow',
           (SELECT COALESCE(sum(expected_ugx),0) FROM j WHERE day BETWEEN d_c0 AND d_c1),
           (SELECT COALESCE(sum(expected_ugx),0) FROM j WHERE day BETWEEN d_p0 AND d_p1),
           'prior_window', (SELECT amt FROM fwd) + 7 * (SELECT amt FROM fallback),
           v_complete || '. Projection = scheduled repayments for the next 7 days (rent_plan_schedule_days) + 7 x yesterday''s past-term fallback bill'
    UNION ALL
    SELECT 110, 'rent_collected_on_schedule_ugx', 'Rent collected against the bill', 'ugx', 'flow',
           (SELECT COALESCE(sum(on_sched),0) FROM j WHERE day BETWEEN d_c0 AND d_c1),
           (SELECT COALESCE(sum(on_sched),0) FROM j WHERE day BETWEEN d_p0 AND d_p1),
           'prior_window', NULL,
           v_complete || '. Per plan per day capped at that day''s bill; arrears excluded';

  -- =========================================================================
  ELSIF p_domain = 'agent' THEN
  -- =========================================================================
    RETURN QUERY
    WITH qual AS (
      -- get_agent_ops_overview baseline agent definition (2026-09-02)
      SELECT uid, min(ts) AS first_ts FROM (
        SELECT ac.agent_id AS uid, min(ac.created_at) AS ts
          FROM agent_collections ac WHERE ac.agent_id IS NOT NULL GROUP BY 1
        UNION ALL
        SELECT COALESCE(rr.assigned_agent_id, rr.agent_id), min(rr.created_at)
          FROM rent_requests rr
         WHERE COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
           AND COALESCE(rr.assigned_agent_id, rr.agent_id) <> rr.tenant_id
         GROUP BY 1
      ) s WHERE uid IS NOT NULL GROUP BY uid
    ), sub AS (
      SELECT sub_agent_id, min(created_at) AS first_ts
        FROM agent_subagents WHERE sub_agent_id IS NOT NULL GROUP BY 1
    )
    SELECT 10, 'agents_total', 'Agents', 'count', 'stock',
           (SELECT count(*)::numeric FROM qual WHERE first_ts < t1),
           (SELECT count(*)::numeric FROM qual WHERE first_ts < t0),
           'reconstructed', NULL::numeric,
           'Agent Ops baseline: collected rent, or acting agent on a rent request that is not their own'
    UNION ALL
    SELECT 20, 'sub_agents_total', 'Sub-agents', 'count', 'stock',
           (SELECT count(*)::numeric FROM sub WHERE first_ts < t1),
           (SELECT count(*)::numeric FROM sub WHERE first_ts < t0),
           'reconstructed', NULL, 'Distinct sub_agent_id in agent_subagents, by first link'
    UNION ALL
    SELECT 30, 'agents_with_live_plans', 'Agents with active Rent Plans', 'count', 'stock',
           (SELECT count(DISTINCT COALESCE(rr.assigned_agent_id, rr.agent_id))::numeric
              FROM rent_requests rr
             WHERE rr.status = ANY (v_live_status)
               AND COALESCE(rr.tenancy_status,'active') <> 'ended'
               AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL),
           NULL, 'snapshot', NULL, 'Distinct COALESCE(assigned_agent_id, agent_id) on active Rent Plans'
    UNION ALL
    SELECT 40, 'advances_outstanding_ugx', 'Agent advances outstanding', 'ugx', 'stock',
           (SELECT COALESCE(sum(outstanding_balance),0) FROM agent_advances
             WHERE status IN ('active','disbursed','overdue')),
           NULL, 'snapshot', NULL, 'Sum of outstanding_balance, advances active/disbursed/overdue';

    IF p_stocks_only THEN RETURN; END IF;

    RETURN QUERY
    WITH qual AS (
      SELECT uid, min(ts) AS first_ts FROM (
        SELECT ac.agent_id AS uid, min(ac.created_at) AS ts
          FROM agent_collections ac WHERE ac.agent_id IS NOT NULL GROUP BY 1
        UNION ALL
        SELECT COALESCE(rr.assigned_agent_id, rr.agent_id), min(rr.created_at)
          FROM rent_requests rr
         WHERE COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
           AND COALESCE(rr.assigned_agent_id, rr.agent_id) <> rr.tenant_id
         GROUP BY 1
      ) s WHERE uid IS NOT NULL GROUP BY uid
    ), comm AS (
      SELECT gl.created_at,
             CASE WHEN gl.direction IN ('cash_in','credit') THEN gl.amount ELSE -gl.amount END AS amt
        FROM general_ledger gl
       WHERE gl.ledger_scope = 'wallet'
         AND gl.direction IN ('cash_in','credit','cash_out','debit')
         AND gl.category IN ('agent_commission_earned','agent_commission','agent_bonus',
                             'agent_investment_commission','proxy_investment_commission','partner_commission')
         AND gl.created_at >= tp AND gl.created_at < t1
    )
    SELECT 50, 'active_agents', 'Active agents (collected rent)', 'count', 'flow',
           (SELECT count(DISTINCT agent_id)::numeric FROM agent_collections
             WHERE agent_id IS NOT NULL AND reversed_at IS NULL AND created_at >= t0 AND created_at < t1),
           (SELECT count(DISTINCT agent_id)::numeric FROM agent_collections
             WHERE agent_id IS NOT NULL AND reversed_at IS NULL AND created_at >= tp AND created_at < t0),
           'prior_window', NULL::numeric, v_rolling
    UNION ALL
    SELECT 60, 'new_agents', 'New agents', 'count', 'flow',
           (SELECT count(*)::numeric FROM qual WHERE first_ts >= t0 AND first_ts < t1),
           (SELECT count(*)::numeric FROM qual WHERE first_ts >= tp AND first_ts < t0),
           'prior_window', NULL, v_rolling || '. First seen under the Agent Ops baseline definition'
    UNION ALL
    SELECT 70, 'collections_count', 'Collections recorded', 'count', 'flow',
           (SELECT count(*)::numeric FROM agent_collections
             WHERE reversed_at IS NULL AND amount > 0 AND created_at >= t0 AND created_at < t1),
           (SELECT count(*)::numeric FROM agent_collections
             WHERE reversed_at IS NULL AND amount > 0 AND created_at >= tp AND created_at < t0),
           'prior_window', NULL, v_rolling || '. Reversals excluded'
    UNION ALL
    SELECT 80, 'collections_ugx', 'Collections value', 'ugx', 'flow',
           (SELECT COALESCE(sum(amount),0) FROM agent_collections
             WHERE reversed_at IS NULL AND amount > 0 AND created_at >= t0 AND created_at < t1),
           (SELECT COALESCE(sum(amount),0) FROM agent_collections
             WHERE reversed_at IS NULL AND amount > 0 AND created_at >= tp AND created_at < t0),
           'prior_window', NULL, v_rolling || '. Reversals excluded'
    UNION ALL
    SELECT 90, 'agent_commission_net_ugx', 'Agent commission (net)', 'ugx', 'flow',
           (SELECT COALESCE(sum(amt),0) FROM comm WHERE created_at >= t0),
           (SELECT COALESCE(sum(amt),0) FROM comm WHERE created_at < t0),
           'prior_window', NULL, v_rolling || '. Wallet ledger, credits minus reversals (same categories as Agent Ops overview)'
    UNION ALL
    SELECT 100, 'advances_disbursed_count', 'Agent advances disbursed', 'count', 'flow',
           (SELECT count(*)::numeric FROM agent_advance_requests WHERE cfo_paid_at >= t0 AND cfo_paid_at < t1),
           (SELECT count(*)::numeric FROM agent_advance_requests WHERE cfo_paid_at >= tp AND cfo_paid_at < t0),
           'prior_window', NULL, v_rolling || '. By cfo_paid_at'
    UNION ALL
    SELECT 110, 'advances_disbursed_ugx', 'Agent advances disbursed (principal)', 'ugx', 'flow',
           (SELECT COALESCE(sum(principal),0) FROM agent_advance_requests WHERE cfo_paid_at >= t0 AND cfo_paid_at < t1),
           (SELECT COALESCE(sum(principal),0) FROM agent_advance_requests WHERE cfo_paid_at >= tp AND cfo_paid_at < t0),
           'prior_window', NULL, v_rolling || '. By cfo_paid_at';

  -- =========================================================================
  ELSIF p_domain = 'partner' THEN
  -- =========================================================================
    RETURN QUERY
    WITH act AS (
      SELECT investor_id, investment_amount FROM investor_portfolios WHERE status = 'active'
    ), firsts AS (
      SELECT investor_id, min(created_at) AS first_at
        FROM investor_portfolios
       WHERE investor_id IS NOT NULL AND status <> 'cancelled'
       GROUP BY 1
    )
    SELECT 10, 'active_partners', 'Active Supporters', 'count', 'stock',
           (SELECT count(DISTINCT investor_id)::numeric FROM act), NULL::numeric, 'snapshot', NULL::numeric,
           'Distinct investor_id with at least one active portfolio'
    UNION ALL
    SELECT 20, 'active_portfolios', 'Active portfolios', 'count', 'stock',
           (SELECT count(*)::numeric FROM act), NULL, 'snapshot', NULL, 'investor_portfolios status = active'
    UNION ALL
    SELECT 30, 'capital_under_management_ugx', 'Supporter capital (active)', 'ugx', 'stock',
           (SELECT COALESCE(sum(investment_amount),0) FROM act), NULL, 'snapshot', NULL,
           'Sum of investment_amount over active portfolios'
    UNION ALL
    SELECT 40, 'partners_total', 'Supporters (all time)', 'count', 'stock',
           (SELECT count(*)::numeric FROM firsts WHERE first_at < t1),
           (SELECT count(*)::numeric FROM firsts WHERE first_at < t0),
           'reconstructed', NULL, 'Distinct investor_id by first non-cancelled portfolio';

    IF p_stocks_only THEN RETURN; END IF;

    RETURN QUERY
    WITH firsts AS (
      SELECT investor_id, min(created_at) AS first_at
        FROM investor_portfolios
       WHERE investor_id IS NOT NULL AND status <> 'cancelled'
       GROUP BY 1
    ), gl AS (
      SELECT g.created_at, g.category, g.direction, g.amount
        FROM general_ledger g
       WHERE g.ledger_scope = 'platform'
         AND g.category IN ('partner_funding','roi_expense','roi_reinvestment')
         AND g.created_at >= tp AND g.created_at < t1
    )
    SELECT 50, 'new_partners', 'New Supporters', 'count', 'flow',
           (SELECT count(*)::numeric FROM firsts WHERE first_at >= t0 AND first_at < t1),
           (SELECT count(*)::numeric FROM firsts WHERE first_at >= tp AND first_at < t0),
           'prior_window', NULL::numeric, v_rolling || '. First non-cancelled portfolio'
    UNION ALL
    SELECT 60, 'new_portfolios', 'New portfolios', 'count', 'flow',
           (SELECT count(*)::numeric FROM investor_portfolios WHERE status <> 'cancelled' AND created_at >= t0 AND created_at < t1),
           (SELECT count(*)::numeric FROM investor_portfolios WHERE status <> 'cancelled' AND created_at >= tp AND created_at < t0),
           'prior_window', NULL, v_rolling
    UNION ALL
    SELECT 70, 'new_partnership_capital_ugx', 'New partnership capital (portfolios opened)', 'ugx', 'flow',
           (SELECT COALESCE(sum(investment_amount),0) FROM investor_portfolios WHERE status <> 'cancelled' AND created_at >= t0 AND created_at < t1),
           (SELECT COALESCE(sum(investment_amount),0) FROM investor_portfolios WHERE status <> 'cancelled' AND created_at >= tp AND created_at < t0),
           'prior_window', NULL, v_rolling || '. Portfolio face value at creation'
    UNION ALL
    SELECT 80, 'partner_funding_received_ugx', 'Partner funding received (ledger)', 'ugx', 'flow',
           (SELECT COALESCE(sum(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END),0)
              FROM gl WHERE category = 'partner_funding' AND created_at >= t0),
           (SELECT COALESCE(sum(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END),0)
              FROM gl WHERE category = 'partner_funding' AND created_at < t0),
           'prior_window', NULL, v_rolling || '. Platform ledger partner_funding, cash_in minus cash_out'
    UNION ALL
    SELECT 90, 'returns_distributed_ugx', 'Returns distributed', 'ugx', 'flow',
           (SELECT COALESCE(sum(amount),0) FROM gl WHERE category = 'roi_expense' AND direction = 'cash_out' AND created_at >= t0),
           (SELECT COALESCE(sum(amount),0) FROM gl WHERE category = 'roi_expense' AND direction = 'cash_out' AND created_at < t0),
           'prior_window', NULL, v_rolling || '. Platform ledger roi_expense cash_out (paid to wallet + reinvested)'
    UNION ALL
    SELECT 100, 'returns_reinvested_ugx', 'Returns reinvested', 'ugx', 'flow',
           (SELECT COALESCE(sum(amount),0) FROM gl WHERE category = 'roi_reinvestment' AND direction = 'cash_in' AND created_at >= t0),
           (SELECT COALESCE(sum(amount),0) FROM gl WHERE category = 'roi_reinvestment' AND direction = 'cash_in' AND created_at < t0),
           'prior_window', NULL, v_rolling || '. Platform ledger roi_reinvestment cash_in';

  -- =========================================================================
  ELSIF p_domain = 'landlord' THEN
  -- =========================================================================
    RETURN QUERY
    SELECT 10, 'landlords_listed', 'Landlords listed', 'count', 'stock',
           (SELECT count(*)::numeric FROM landlords WHERE created_at < t1 AND COALESCE(verification_status,'') <> 'rejected'),
           (SELECT count(*)::numeric FROM landlords WHERE created_at < t0 AND COALESCE(verification_status,'') <> 'rejected'),
           'reconstructed', NULL::numeric, 'landlords rows by created_at, excluding currently rejected'
    UNION ALL
    SELECT 20, 'landlords_verified', 'Landlords verified', 'count', 'stock',
           (SELECT count(*)::numeric FROM landlords WHERE verified AND verified_at < t1),
           (SELECT count(*)::numeric FROM landlords WHERE verified AND verified_at < t0),
           'reconstructed', NULL, 'landlords.verified by verified_at'
    UNION ALL
    SELECT 30, 'houses_listed', 'Houses listed', 'count', 'stock',
           (SELECT count(*)::numeric FROM house_listings WHERE created_at < t1 AND COALESCE(status,'') <> 'rejected'),
           (SELECT count(*)::numeric FROM house_listings WHERE created_at < t0 AND COALESCE(status,'') <> 'rejected'),
           'reconstructed', NULL, 'house_listings by created_at, excluding currently rejected'
    UNION ALL
    SELECT 40, 'houses_recognised', 'Houses recognised (verified)', 'count', 'stock',
           (SELECT count(*)::numeric FROM house_listings WHERE verified AND verified_at < t1),
           (SELECT count(*)::numeric FROM house_listings WHERE verified AND verified_at < t0),
           'reconstructed', NULL, 'house_listings.verified by verified_at'
    UNION ALL
    SELECT 50, 'landlords_with_funded_plan', 'Landlords paid through a Rent Plan', 'count', 'stock',
           (SELECT count(DISTINCT landlord_id)::numeric FROM rent_requests WHERE landlord_id IS NOT NULL AND funded_at < t1),
           (SELECT count(DISTINCT landlord_id)::numeric FROM rent_requests WHERE landlord_id IS NOT NULL AND funded_at < t0),
           'reconstructed', NULL, 'Distinct landlord_id on a Rent Plan with funded_at before the point in time';

    IF p_stocks_only THEN RETURN; END IF;

    RETURN QUERY
    SELECT 60, 'new_landlords_listed', 'New landlords listed', 'count', 'flow',
           (SELECT count(*)::numeric FROM landlords WHERE created_at >= t0 AND created_at < t1),
           (SELECT count(*)::numeric FROM landlords WHERE created_at >= tp AND created_at < t0),
           'prior_window', NULL::numeric, v_rolling
    UNION ALL
    SELECT 70, 'new_landlords_verified', 'Landlords verified this week', 'count', 'flow',
           (SELECT count(*)::numeric FROM landlords WHERE verified AND verified_at >= t0 AND verified_at < t1),
           (SELECT count(*)::numeric FROM landlords WHERE verified AND verified_at >= tp AND verified_at < t0),
           'prior_window', NULL, v_rolling
    UNION ALL
    SELECT 80, 'new_houses_listed', 'New houses listed', 'count', 'flow',
           (SELECT count(*)::numeric FROM house_listings WHERE created_at >= t0 AND created_at < t1),
           (SELECT count(*)::numeric FROM house_listings WHERE created_at >= tp AND created_at < t0),
           'prior_window', NULL, v_rolling
    UNION ALL
    SELECT 90, 'new_houses_recognised', 'Houses verified this week', 'count', 'flow',
           (SELECT count(*)::numeric FROM house_listings WHERE verified AND verified_at >= t0 AND verified_at < t1),
           (SELECT count(*)::numeric FROM house_listings WHERE verified AND verified_at >= tp AND verified_at < t0),
           'prior_window', NULL, v_rolling
    UNION ALL
    SELECT 100, 'landlord_payouts_count', 'Landlord payouts disbursed', 'count', 'flow',
           (SELECT count(*)::numeric FROM landlord_payouts WHERE disbursed_at >= t0 AND disbursed_at < t1),
           (SELECT count(*)::numeric FROM landlord_payouts WHERE disbursed_at >= tp AND disbursed_at < t0),
           'prior_window', NULL, v_rolling || '. landlord_payouts by disbursed_at'
    UNION ALL
    SELECT 110, 'landlord_payouts_ugx', 'Landlord payouts disbursed (value)', 'ugx', 'flow',
           (SELECT COALESCE(sum(amount),0) FROM landlord_payouts WHERE disbursed_at >= t0 AND disbursed_at < t1),
           (SELECT COALESCE(sum(amount),0) FROM landlord_payouts WHERE disbursed_at >= tp AND disbursed_at < t0),
           'prior_window', NULL, v_rolling || '. landlord_payouts by disbursed_at';

  ELSE
    RAISE EXCEPTION 'unknown_domain: %', p_domain;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public._exec_ops_metrics_raw(text, timestamptz, boolean) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Shared finisher: week-ago resolution, net change, projection
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._exec_ops_weekly_metrics(p_domain text)
RETURNS TABLE (
  metric_key        text,
  label             text,
  unit              text,
  metric_kind       text,
  current_value     numeric,
  week_ago_value    numeric,
  net_change        numeric,
  pct_change        numeric,
  projection_7d     numeric,
  projection_method text,
  week_ago_source   text,
  week_ago_at       timestamptz,
  basis             text,
  as_of             timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH r AS (
    SELECT * FROM public._exec_ops_metrics_raw(p_domain, now(), false)
  ), s AS (
    -- nearest hourly snapshot to now() - 7 days, within +/- 3 hours
    SELECT r.metric_key, snap.value, snap.captured_at
      FROM r
      LEFT JOIN LATERAL (
        SELECT e.value, e.captured_at
          FROM public.exec_ops_metric_snapshots e
         WHERE e.domain = p_domain
           AND e.metric_key = r.metric_key
           AND e.captured_at BETWEEN now() - interval '7 days 3 hours'
                                 AND now() - interval '6 days 21 hours'
         ORDER BY abs(extract(epoch FROM e.captured_at - (now() - interval '7 days')))
         LIMIT 1
      ) snap ON true
     WHERE r.prior_basis = 'snapshot'
  ), w AS (
    SELECT r.*,
           CASE WHEN r.prior_basis = 'snapshot' THEN s.value ELSE r.prior_value END AS wa,
           CASE WHEN r.prior_basis = 'snapshot'
                THEN CASE WHEN s.value IS NULL THEN 'no_snapshot_yet' ELSE 'snapshot' END
                ELSE r.prior_basis END AS wa_src,
           CASE WHEN r.prior_basis = 'snapshot' THEN s.captured_at
                ELSE now() - interval '7 days' END AS wa_at
      FROM r LEFT JOIN s ON s.metric_key = r.metric_key
  )
  SELECT w.metric_key, w.label, w.unit, w.metric_kind,
         w.current_value,
         w.wa,
         w.current_value - w.wa,
         CASE WHEN w.wa IS NULL OR w.wa = 0 THEN NULL
              ELSE round((w.current_value - w.wa) / abs(w.wa) * 100, 1) END,
         CASE WHEN w.projection_override IS NOT NULL THEN w.projection_override
              WHEN w.metric_kind = 'flow' THEN w.current_value
              WHEN w.wa IS NULL THEN NULL
              ELSE GREATEST(0, w.current_value + (w.current_value - w.wa)) END,
         CASE WHEN w.projection_override IS NOT NULL THEN 'schedule_plus_past_term'
              WHEN w.metric_kind = 'flow' THEN 'run_rate_7d'
              WHEN w.wa IS NULL THEN 'unavailable'
              ELSE 'linear_wow' END,
         w.wa_src, w.wa_at, w.basis, now()
    FROM w
   ORDER BY w.sort_order;
$function$;

REVOKE ALL ON FUNCTION public._exec_ops_weekly_metrics(text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Access gate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._exec_ops_metrics_authorize(p_dept_role text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;
  IF NOT (
    public.is_ops_role(v_uid)  -- manager, super_admin, coo, operations
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
       WHERE ur.user_id = v_uid
         AND ur.enabled = true
         AND ur.role::text IN ('ceo','cfo','cto','financial_ops', p_dept_role)
    )
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public._exec_ops_metrics_authorize(text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Public RPCs — the only thing dashboards call
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_tenant_ops_weekly_metrics()
RETURNS TABLE (metric_key text, label text, unit text, metric_kind text,
               current_value numeric, week_ago_value numeric, net_change numeric,
               pct_change numeric, projection_7d numeric, projection_method text,
               week_ago_source text, week_ago_at timestamptz, basis text, as_of timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._exec_ops_metrics_authorize('tenant_ops');
  RETURN QUERY SELECT * FROM public._exec_ops_weekly_metrics('tenant');
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_agent_ops_weekly_metrics()
RETURNS TABLE (metric_key text, label text, unit text, metric_kind text,
               current_value numeric, week_ago_value numeric, net_change numeric,
               pct_change numeric, projection_7d numeric, projection_method text,
               week_ago_source text, week_ago_at timestamptz, basis text, as_of timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._exec_ops_metrics_authorize('agent_ops');
  RETURN QUERY SELECT * FROM public._exec_ops_weekly_metrics('agent');
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_partner_ops_weekly_metrics()
RETURNS TABLE (metric_key text, label text, unit text, metric_kind text,
               current_value numeric, week_ago_value numeric, net_change numeric,
               pct_change numeric, projection_7d numeric, projection_method text,
               week_ago_source text, week_ago_at timestamptz, basis text, as_of timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._exec_ops_metrics_authorize('partner_ops');
  RETURN QUERY SELECT * FROM public._exec_ops_weekly_metrics('partner');
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_landlord_ops_weekly_metrics()
RETURNS TABLE (metric_key text, label text, unit text, metric_kind text,
               current_value numeric, week_ago_value numeric, net_change numeric,
               pct_change numeric, projection_7d numeric, projection_method text,
               week_ago_source text, week_ago_at timestamptz, basis text, as_of timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._exec_ops_metrics_authorize('landlord_ops');
  RETURN QUERY SELECT * FROM public._exec_ops_weekly_metrics('landlord');
END;
$function$;

REVOKE ALL ON FUNCTION public.get_tenant_ops_weekly_metrics()   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_agent_ops_weekly_metrics()    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_partner_ops_weekly_metrics()  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_landlord_ops_weekly_metrics() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tenant_ops_weekly_metrics()   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_agent_ops_weekly_metrics()    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_partner_ops_weekly_metrics()  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_landlord_ops_weekly_metrics() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Hourly snapshot capture + 90-day prune
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.capture_exec_ops_metric_snapshots()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := date_trunc('minute', now());
  v_n   integer;
BEGIN
  INSERT INTO public.exec_ops_metric_snapshots (domain, metric_key, captured_at, value)
  SELECT d.domain, r.metric_key, v_now, r.current_value
    FROM unnest(ARRAY['tenant','agent','partner','landlord']) AS d(domain)
    CROSS JOIN LATERAL public._exec_ops_metrics_raw(d.domain, v_now, true) r
   WHERE r.metric_kind = 'stock' AND r.current_value IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  DELETE FROM public.exec_ops_metric_snapshots WHERE captured_at < now() - interval '90 days';
  RETURN v_n;
END;
$function$;

REVOKE ALL ON FUNCTION public.capture_exec_ops_metric_snapshots() FROM PUBLIC, anon, authenticated;

DO $cron$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'exec-ops-metric-snapshots-hourly';
  PERFORM cron.schedule('exec-ops-metric-snapshots-hourly', '7 * * * *',
                        'SELECT public.capture_exec_ops_metric_snapshots();');
END
$cron$;

-- Seed the first snapshot so the 7-day clock starts at deploy.
SELECT public.capture_exec_ops_metric_snapshots();

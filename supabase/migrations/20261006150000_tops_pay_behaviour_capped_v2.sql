-- Tenant Payment Behavior: money figures that agree with Tenant Ops Home. Additive, read-only.
--
-- Home (ops_tenant_ops_home_range) counts as "collected" only what a Rent Plan paid up to its own bill for
-- the period: per Rent Plan, LEAST(paid in the window, billed in the window). The Payment Behavior reports
-- added up every payment, so their money headlines were larger than Home's. This migration adds _v2 reports
-- that count the same way and show the rest as "paid ahead / above the bill". The old functions stay.
--
-- New objects (nothing existing is changed):
--   tops_pay_behaviour_payments_capped(...)  tops_pay_behaviour_payments plus pay_counted_ugx and pay_excess_ugx.
--       A plan's bill (agent_expected_day_plans from the first Kampala day of the period to the earlier of the
--       last day and today) is shared across its payments oldest first. The counted amounts of a plan add up to
--       LEAST(paid, billed); anything above goes to pay_excess_ugx. A payment on a plan with no bill is all excess.
--   tops_pay_behaviour_plans_capped(...)     tops_pay_behaviour_plans on the counted amounts, plus paid-ahead columns.
--   tops_payment_behaviour_{summary,overview,trend,timing,by,watchlist}_v2
--       Same response shape as the originals, fields added only (a paid_ahead block with paid_ahead_ugx and
--       paid_ahead_n, split into self, agent and other). Every money total, share, average and median uses the
--       counted amounts. Counts of payments and of tenants are unchanged (they count events and people).
--
-- Averages and medians are taken over payments that contributed counted money (counted > 0), so a payment that
-- is entirely above the bill does not drag them to zero. Their payment count is returned as counted_n.

-- ─── payments with counted and excess amounts ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.tops_pay_behaviour_payments_capped(
  p_start timestamptz,
  p_end timestamptz,
  p_agent_id uuid DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_cadence text DEFAULT NULL
)
RETURNS TABLE(
  pay_id uuid, pay_rr uuid, pay_tenant uuid, pay_agent uuid, pay_channel text, pay_amount numeric,
  pay_at timestamptz, pay_day date, pay_hour integer, pay_dow integer,
  pay_counted_ugx numeric, pay_excess_ugx numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_d1 date := (p_start AT TIME ZONE 'Africa/Kampala')::date;
  v_d2 date := (p_end AT TIME ZONE 'Africa/Kampala')::date;
  v_asof date;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  v_asof := LEAST(v_d2, (now() AT TIME ZONE 'Africa/Kampala')::date);

  RETURN QUERY
  WITH pay AS MATERIALIZED (
    SELECT p.*
    FROM public.tops_pay_behaviour_payments(p_start, p_end, p_agent_id, p_region, p_district, p_cadence) p
    WHERE p.pay_at <= now()
  ),
  bill AS (
    SELECT dp.rent_request_id AS b_rr, GREATEST(SUM(dp.expected_ugx), 0) AS b_ugx
    FROM public.agent_expected_day_plans dp
    WHERE dp.day BETWEEN v_d1 AND v_asof
      AND dp.rent_request_id IN (SELECT q.pay_rr FROM pay q)
    GROUP BY dp.rent_request_id
  ),
  run AS (
    SELECT y.pay_id AS r_id, y.pay_rr AS r_rr, y.pay_tenant AS r_tenant, y.pay_agent AS r_agent, y.pay_channel AS r_channel,
           y.pay_amount AS r_amount, y.pay_at AS r_at, y.pay_day AS r_day, y.pay_hour AS r_hour, y.pay_dow AS r_dow,
           COALESCE(b.b_ugx, 0) AS r_bill,
           COALESCE(SUM(y.pay_amount) OVER (PARTITION BY y.pay_rr ORDER BY y.pay_at, y.pay_id
                                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS r_prior
    FROM pay y
    LEFT JOIN bill b ON b.b_rr = y.pay_rr
  )
  SELECT r.r_id, r.r_rr, r.r_tenant, r.r_agent, r.r_channel, r.r_amount, r.r_at, r.r_day, r.r_hour, r.r_dow,
         LEAST(r.r_amount, GREATEST(r.r_bill - r.r_prior, 0)),
         r.r_amount - LEAST(r.r_amount, GREATEST(r.r_bill - r.r_prior, 0))
  FROM run r;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_pay_behaviour_payments_capped(timestamptz, timestamptz, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_pay_behaviour_payments_capped(timestamptz, timestamptz, uuid, text, text, text) TO authenticated;

-- ─── one row per Rent Plan, counted amounts ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tops_pay_behaviour_plans_capped(
  p_start timestamptz,
  p_end timestamptz,
  p_agent_id uuid DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_cadence text DEFAULT NULL
)
RETURNS TABLE(
  pl_rr uuid, pl_tenant uuid, pl_agent uuid, pl_cadence text, pl_rent numeric, pl_start date,
  pl_billed_days integer, pl_billed_ugx numeric, pl_paid_ugx numeric,
  pl_self_ugx numeric, pl_agent_ugx numeric, pl_other_ugx numeric,
  pl_self_n integer, pl_agent_n integer, pl_other_n integer,
  pl_paid_days integer, pl_first_paid timestamptz, pl_last_paid timestamptz,
  pl_covered_ugx numeric, pl_segment text,
  pl_ahead_ugx numeric, pl_ahead_self_ugx numeric, pl_ahead_agent_ugx numeric, pl_ahead_other_ugx numeric,
  pl_ahead_n integer, pl_ahead_self_n integer, pl_ahead_agent_n integer, pl_ahead_other_n integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_d1 date;
  v_d2 date;
  v_asof date;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  v_d1 := (p_start AT TIME ZONE 'Africa/Kampala')::date;
  v_d2 := (p_end AT TIME ZONE 'Africa/Kampala')::date;
  v_asof := LEAST(v_d2, (now() AT TIME ZONE 'Africa/Kampala')::date);

  RETURN QUERY
  WITH sc AS MATERIALIZED (
    SELECT * FROM public.tops_pay_behaviour_scope(p_agent_id, p_region, p_district, p_cadence)
  ),
  bill AS (
    SELECT dp.rent_request_id AS rr_id,
           count(DISTINCT dp.day) FILTER (WHERE dp.expected_ugx > 0)::int AS billed_days,
           SUM(dp.expected_ugx) AS billed_ugx
    FROM public.agent_expected_day_plans dp
    WHERE dp.day BETWEEN v_d1 AND v_asof
      AND dp.rent_request_id IN (SELECT s0.sc_rr FROM sc s0)
    GROUP BY dp.rent_request_id
  ),
  pay AS (
    SELECT p.pay_rr AS rr_id,
           SUM(p.pay_counted_ugx) AS paid_ugx,
           SUM(p.pay_counted_ugx) FILTER (WHERE p.pay_channel = 'self') AS self_ugx,
           SUM(p.pay_counted_ugx) FILTER (WHERE p.pay_channel = 'agent') AS agent_ugx,
           SUM(p.pay_counted_ugx) FILTER (WHERE p.pay_channel = 'other') AS other_ugx,
           count(*) FILTER (WHERE p.pay_channel = 'self')::int AS self_n,
           count(*) FILTER (WHERE p.pay_channel = 'agent')::int AS agent_n,
           count(*) FILTER (WHERE p.pay_channel = 'other')::int AS other_n,
           count(DISTINCT p.pay_day)::int AS paid_days,
           MIN(p.pay_at) AS first_paid,
           MAX(p.pay_at) AS last_paid,
           SUM(p.pay_excess_ugx) AS ahead_ugx,
           SUM(p.pay_excess_ugx) FILTER (WHERE p.pay_channel = 'self') AS ahead_self_ugx,
           SUM(p.pay_excess_ugx) FILTER (WHERE p.pay_channel = 'agent') AS ahead_agent_ugx,
           SUM(p.pay_excess_ugx) FILTER (WHERE p.pay_channel = 'other') AS ahead_other_ugx,
           count(*) FILTER (WHERE p.pay_excess_ugx > 0)::int AS ahead_n,
           count(*) FILTER (WHERE p.pay_excess_ugx > 0 AND p.pay_channel = 'self')::int AS ahead_self_n,
           count(*) FILTER (WHERE p.pay_excess_ugx > 0 AND p.pay_channel = 'agent')::int AS ahead_agent_n,
           count(*) FILTER (WHERE p.pay_excess_ugx > 0 AND p.pay_channel = 'other')::int AS ahead_other_n
    FROM public.tops_pay_behaviour_payments_capped(p_start, p_end, p_agent_id, p_region, p_district, p_cadence) p
    GROUP BY p.pay_rr
  )
  SELECT
    s.sc_rr,
    s.sc_tenant,
    s.sc_agent,
    s.sc_cadence,
    s.sc_rent,
    s.sc_start,
    COALESCE(b.billed_days, 0),
    COALESCE(b.billed_ugx, 0),
    COALESCE(y.paid_ugx, 0),
    COALESCE(y.self_ugx, 0),
    COALESCE(y.agent_ugx, 0),
    COALESCE(y.other_ugx, 0),
    COALESCE(y.self_n, 0),
    COALESCE(y.agent_n, 0),
    COALESCE(y.other_n, 0),
    COALESCE(y.paid_days, 0),
    y.first_paid,
    y.last_paid,
    LEAST(COALESCE(y.paid_ugx, 0), COALESCE(b.billed_ugx, 0)),
    CASE
      WHEN COALESCE(y.self_n, 0) > 0 AND COALESCE(y.agent_n, 0) > 0 THEN 'mixed'
      WHEN COALESCE(y.self_n, 0) > 0 THEN 'self_only'
      WHEN COALESCE(y.agent_n, 0) > 0 THEN 'agent_only'
      ELSE 'no_payment'
    END,
    COALESCE(y.ahead_ugx, 0),
    COALESCE(y.ahead_self_ugx, 0),
    COALESCE(y.ahead_agent_ugx, 0),
    COALESCE(y.ahead_other_ugx, 0),
    COALESCE(y.ahead_n, 0),
    COALESCE(y.ahead_self_n, 0),
    COALESCE(y.ahead_agent_n, 0),
    COALESCE(y.ahead_other_n, 0)
  FROM sc s
  LEFT JOIN bill b ON b.rr_id = s.sc_rr
  LEFT JOIN pay y ON y.rr_id = s.sc_rr
  WHERE b.rr_id IS NOT NULL OR y.rr_id IS NOT NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_pay_behaviour_plans_capped(timestamptz, timestamptz, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_pay_behaviour_plans_capped(timestamptz, timestamptz, uuid, text, text, text) TO authenticated;

-- ─── summary_v2 ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tops_payment_behaviour_summary_v2(
  p_start timestamptz,
  p_end timestamptz,
  p_agent_id uuid DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_cadence text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_d1 date := (p_start AT TIME ZONE 'Africa/Kampala')::date;
  v_d2 date := (p_end AT TIME ZONE 'Africa/Kampala')::date;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_asof date;
  v_days int;
  v_prev_start timestamptz;
  v_prev_end timestamptz;
  v_prev_paying int;
  v_prev_self int;
  v_prev_pct numeric;
  v_result jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  v_asof := LEAST(v_d2, v_today);
  v_days := (v_d2 - v_d1) + 1;
  v_prev_start := ((v_d1 - v_days)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_prev_end := ((v_d1 - 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  SELECT count(DISTINCT p.pay_tenant)::int, count(DISTINCT p.pay_tenant) FILTER (WHERE p.pay_channel = 'self')::int
    INTO v_prev_paying, v_prev_self
  FROM public.tops_pay_behaviour_payments(v_prev_start, v_prev_end, p_agent_id, p_region, p_district, p_cadence) p;
  v_prev_pct := round(v_prev_self::numeric / NULLIF(v_prev_paying, 0) * 100, 1);

  WITH pl AS MATERIALIZED (
    SELECT * FROM public.tops_pay_behaviour_plans_capped(p_start, p_end, p_agent_id, p_region, p_district, p_cadence)
  ),
  pay AS MATERIALIZED (
    SELECT * FROM public.tops_pay_behaviour_payments_capped(p_start, p_end, p_agent_id, p_region, p_district, p_cadence)
  ),
  t AS (
    SELECT l.pl_tenant AS tn,
           SUM(l.pl_billed_ugx) AS billed, SUM(l.pl_covered_ugx) AS covered,
           SUM(l.pl_self_n) AS self_n, SUM(l.pl_agent_n) AS agent_n
    FROM pl l GROUP BY l.pl_tenant
  ),
  ts AS (
    SELECT t0.*,
           CASE WHEN t0.self_n > 0 AND t0.agent_n > 0 THEN 'mixed'
                WHEN t0.self_n > 0 THEN 'self_only'
                WHEN t0.agent_n > 0 THEN 'agent_only'
                ELSE 'no_payment' END AS seg
    FROM t t0
  ),
  chan AS (
    SELECT c.ch,
           count(p.pay_id)::int AS n,
           count(p.pay_id) FILTER (WHERE p.pay_counted_ugx > 0)::int AS counted_n,
           COALESCE(SUM(p.pay_counted_ugx), 0) AS ugx,
           round(AVG(p.pay_counted_ugx) FILTER (WHERE p.pay_counted_ugx > 0), 0) AS avg_ugx,
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY p.pay_counted_ugx) FILTER (WHERE p.pay_counted_ugx > 0))::numeric, 0) AS median_ugx,
           count(DISTINCT p.pay_tenant)::int AS tenants,
           COALESCE(SUM(p.pay_excess_ugx), 0) AS ahead_ugx,
           count(p.pay_id) FILTER (WHERE p.pay_excess_ugx > 0)::int AS ahead_n
    FROM (VALUES ('self'), ('agent'), ('other')) c(ch)
    LEFT JOIN pay p ON p.pay_channel = c.ch
    GROUP BY c.ch
  ),
  seg AS (
    SELECT s.seg, count(*)::int AS tenants,
           COALESCE(SUM(s.billed), 0) AS billed, COALESCE(SUM(s.covered), 0) AS covered
    FROM ts s WHERE s.billed > 0 OR s.seg <> 'no_payment' GROUP BY s.seg
  ),
  tot AS (
    SELECT count(*) FILTER (WHERE s.billed > 0)::int AS billed_tenants,
           count(*) FILTER (WHERE s.seg <> 'no_payment')::int AS paying,
           count(*) FILTER (WHERE s.self_n > 0)::int AS self_payers,
           count(*) FILTER (WHERE s.agent_n > 0)::int AS agent_paid,
           count(*) FILTER (WHERE s.seg = 'self_only')::int AS self_only,
           count(*) FILTER (WHERE s.seg = 'agent_only')::int AS agent_only,
           count(*) FILTER (WHERE s.seg = 'mixed')::int AS mixed,
           count(*) FILTER (WHERE s.seg = 'no_payment' AND s.billed > 0)::int AS billed_not_paying,
           COALESCE(SUM(s.billed), 0) AS billed_ugx,
           COALESCE(SUM(s.covered), 0) AS covered_ugx
    FROM ts s
  ),
  ahead AS (
    SELECT COALESCE(SUM(l.pl_ahead_ugx) FILTER (WHERE l.pl_billed_ugx <= 0), 0) AS no_bill_ugx,
           count(*) FILTER (WHERE l.pl_billed_ugx <= 0 AND l.pl_ahead_ugx > 0)::int AS no_bill_plans,
           COALESCE(SUM(l.pl_ahead_n) FILTER (WHERE l.pl_billed_ugx <= 0), 0)::int AS no_bill_n,
           COALESCE(SUM(l.pl_ahead_ugx) FILTER (WHERE l.pl_billed_ugx > 0), 0) AS above_bill_ugx,
           count(*) FILTER (WHERE l.pl_billed_ugx > 0 AND l.pl_ahead_ugx > 0)::int AS above_bill_plans,
           COALESCE(SUM(l.pl_ahead_n) FILTER (WHERE l.pl_billed_ugx > 0), 0)::int AS above_bill_n
    FROM pl l
  )
  SELECT jsonb_build_object(
    'window', jsonb_build_object('start_day', v_d1, 'end_day', v_d2, 'asof', v_asof, 'days', v_days),
    'data_since', jsonb_build_object(
      'first_self_payment_day', (SELECT (MIN(ac.created_at) AT TIME ZONE 'Africa/Kampala')::date FROM public.agent_collections ac WHERE ac.collection_channel = 'tenant_deposit_auto' AND ac.amount > 0 AND ac.reversed_at IS NULL),
      'first_billed_day', (SELECT MIN(dp.day) FROM public.agent_expected_day_plans dp)
    ),
    'basis', 'Self = collection_channel tenant_deposit_auto (tenant paid from their own number). Agent = agent_float (agent paid from their float). Reversed, zero and plan-less receipts excluded. Kampala days. Coverage = LEAST(paid, billed) / billed per Rent Plan. Money counted as collected is each Rent Plan''s payments up to its bill for the period, oldest payment first, the same as Tenant Ops Home; anything above the bill is shown as paid ahead.',
    'payments', jsonb_build_object(
      'self', (SELECT jsonb_build_object('n', c.n, 'counted_n', c.counted_n, 'ugx', c.ugx, 'avg_ugx', c.avg_ugx, 'median_ugx', c.median_ugx, 'tenants', c.tenants, 'paid_ahead_ugx', c.ahead_ugx, 'paid_ahead_n', c.ahead_n) FROM chan c WHERE c.ch = 'self'),
      'agent', (SELECT jsonb_build_object('n', c.n, 'counted_n', c.counted_n, 'ugx', c.ugx, 'avg_ugx', c.avg_ugx, 'median_ugx', c.median_ugx, 'tenants', c.tenants, 'paid_ahead_ugx', c.ahead_ugx, 'paid_ahead_n', c.ahead_n) FROM chan c WHERE c.ch = 'agent'),
      'other', (SELECT jsonb_build_object('n', c.n, 'counted_n', c.counted_n, 'ugx', c.ugx, 'avg_ugx', c.avg_ugx, 'median_ugx', c.median_ugx, 'tenants', c.tenants, 'paid_ahead_ugx', c.ahead_ugx, 'paid_ahead_n', c.ahead_n) FROM chan c WHERE c.ch = 'other'),
      'total_n', (SELECT SUM(c.n) FROM chan c),
      'total_ugx', (SELECT SUM(c.ugx) FROM chan c),
      'raw_total_ugx', (SELECT SUM(c.ugx + c.ahead_ugx) FROM chan c),
      'self_share_pct', (SELECT round(MAX(c.ugx) FILTER (WHERE c.ch = 'self') / NULLIF(SUM(c.ugx), 0) * 100, 1) FROM chan c),
      'agent_share_pct', (SELECT round(MAX(c.ugx) FILTER (WHERE c.ch = 'agent') / NULLIF(SUM(c.ugx), 0) * 100, 1) FROM chan c),
      'self_count_share_pct', (SELECT round(MAX(c.n) FILTER (WHERE c.ch = 'self')::numeric / NULLIF(SUM(c.n), 0) * 100, 1) FROM chan c)
    ),
    'paid_ahead', jsonb_build_object(
      'definition', 'Money paid on a Rent Plan above what that plan was billed for the period, plus payments on plans with no bill in the period. Not counted as collected, the same as Tenant Ops Home.',
      'paid_ahead_ugx', (SELECT SUM(c.ahead_ugx) FROM chan c),
      'paid_ahead_n', (SELECT SUM(c.ahead_n) FROM chan c)::int,
      'self', (SELECT jsonb_build_object('paid_ahead_ugx', c.ahead_ugx, 'paid_ahead_n', c.ahead_n) FROM chan c WHERE c.ch = 'self'),
      'agent', (SELECT jsonb_build_object('paid_ahead_ugx', c.ahead_ugx, 'paid_ahead_n', c.ahead_n) FROM chan c WHERE c.ch = 'agent'),
      'other', (SELECT jsonb_build_object('paid_ahead_ugx', c.ahead_ugx, 'paid_ahead_n', c.ahead_n) FROM chan c WHERE c.ch = 'other'),
      'no_bill', (SELECT jsonb_build_object('plans', a.no_bill_plans, 'paid_ahead_ugx', a.no_bill_ugx, 'paid_ahead_n', a.no_bill_n) FROM ahead a),
      'above_bill', (SELECT jsonb_build_object('plans', a.above_bill_plans, 'paid_ahead_ugx', a.above_bill_ugx, 'paid_ahead_n', a.above_bill_n) FROM ahead a)
    ),
    'tenants', (SELECT jsonb_build_object(
      'billed', x.billed_tenants, 'paying', x.paying, 'self_payers', x.self_payers, 'agent_paid', x.agent_paid,
      'self_only', x.self_only, 'agent_only', x.agent_only, 'mixed', x.mixed, 'billed_not_paying', x.billed_not_paying,
      'self_payers_pct', round(x.self_payers::numeric / NULLIF(x.paying, 0) * 100, 1),
      'self_only_pct', round(x.self_only::numeric / NULLIF(x.paying, 0) * 100, 1),
      'agent_only_pct', round(x.agent_only::numeric / NULLIF(x.paying, 0) * 100, 1),
      'mixed_pct', round(x.mixed::numeric / NULLIF(x.paying, 0) * 100, 1),
      'previous', jsonb_build_object('paying', v_prev_paying, 'self_payers', v_prev_self, 'self_payers_pct', v_prev_pct),
      'self_payers_pct_change_pp', round(x.self_payers::numeric / NULLIF(x.paying, 0) * 100 - v_prev_pct, 1)
    ) FROM tot x),
    'coverage', jsonb_build_object(
      'billed_ugx', (SELECT x.billed_ugx FROM tot x),
      'covered_ugx', (SELECT x.covered_ugx FROM tot x),
      'short_ugx', (SELECT x.billed_ugx - x.covered_ugx FROM tot x),
      'coverage_pct', (SELECT round(x.covered_ugx / NULLIF(x.billed_ugx, 0) * 100, 1) FROM tot x),
      'by_segment', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'segment', s.seg, 'tenants', s.tenants, 'billed_ugx', s.billed, 'covered_ugx', s.covered,
          'short_ugx', s.billed - s.covered, 'coverage_pct', round(s.covered / NULLIF(s.billed, 0) * 100, 1))
          ORDER BY CASE s.seg WHEN 'self_only' THEN 1 WHEN 'mixed' THEN 2 WHEN 'agent_only' THEN 3 ELSE 4 END) FROM seg s), '[]'::jsonb)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_payment_behaviour_summary_v2(timestamptz, timestamptz, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_payment_behaviour_summary_v2(timestamptz, timestamptz, uuid, text, text, text) TO authenticated;

-- ─── overview_v2 ────────────────────────────────────────────────────────────────
-- A tenant's self-pay share is the share of their counted money. A tenant who paid only above the bill has no
-- counted money, so their label and the moving-to-agents test fall back to the share of everything they paid:
-- someone who paid is never labelled "no payment" just because the money was ahead of the bill.

CREATE OR REPLACE FUNCTION public.tops_payment_behaviour_overview_v2(
  p_start timestamptz,
  p_end timestamptz,
  p_agent_id uuid DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_cadence text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_d1 date := (p_start AT TIME ZONE 'Africa/Kampala')::date;
  v_d2 date := (p_end AT TIME ZONE 'Africa/Kampala')::date;
  v_days int;
  v_prev_start timestamptz;
  v_prev_end timestamptz;
  v_summary jsonb;
  v_result jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  v_days := (v_d2 - v_d1) + 1;
  v_prev_start := ((v_d1 - v_days)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_prev_end := ((v_d1 - 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_summary := public.tops_payment_behaviour_summary_v2(p_start, p_end, p_agent_id, p_region, p_district, p_cadence);

  WITH pl AS MATERIALIZED (
    SELECT * FROM public.tops_pay_behaviour_plans_capped(p_start, p_end, p_agent_id, p_region, p_district, p_cadence)
  ),
  prev AS MATERIALIZED (
    SELECT p.pay_tenant AS tn,
           COALESCE(SUM(p.pay_counted_ugx) FILTER (WHERE p.pay_channel = 'self'), 0) AS self_ugx,
           COALESCE(SUM(p.pay_counted_ugx) FILTER (WHERE p.pay_channel = 'agent'), 0) AS agent_ugx,
           COALESCE(SUM(p.pay_amount) FILTER (WHERE p.pay_channel = 'self'), 0) AS self_all,
           COALESCE(SUM(p.pay_amount) FILTER (WHERE p.pay_channel = 'agent'), 0) AS agent_all
    FROM public.tops_pay_behaviour_payments_capped(v_prev_start, v_prev_end, p_agent_id, p_region, p_district, p_cadence) p
    GROUP BY p.pay_tenant
  ),
  t AS MATERIALIZED (
    SELECT l.pl_tenant AS tn,
           SUM(l.pl_billed_ugx) AS billed, SUM(l.pl_covered_ugx) AS covered,
           SUM(l.pl_self_ugx) AS self_ugx, SUM(l.pl_agent_ugx) AS agent_ugx,
           SUM(l.pl_self_ugx + l.pl_ahead_self_ugx) AS self_all, SUM(l.pl_agent_ugx + l.pl_ahead_agent_ugx) AS agent_all,
           SUM(l.pl_self_n) AS self_n, SUM(l.pl_agent_n) AS agent_n,
           SUM(l.pl_billed_days) AS billed_days, SUM(l.pl_paid_days) AS paid_days,
           MAX(l.pl_rent) AS rent, MIN(l.pl_start) AS plan_start
    FROM pl l GROUP BY l.pl_tenant
  ),
  ts AS MATERIALIZED (
    SELECT t0.*,
           CASE WHEN t0.self_ugx + t0.agent_ugx > 0 THEN t0.self_ugx / (t0.self_ugx + t0.agent_ugx)
                WHEN t0.self_all + t0.agent_all > 0 THEN t0.self_all / (t0.self_all + t0.agent_all) END AS self_share,
           CASE WHEN t0.billed > 0 THEN t0.covered / t0.billed END AS cov,
           CASE WHEN t0.billed_days > 0 THEN LEAST(1.0, t0.paid_days::numeric / t0.billed_days) END AS day_ratio,
           pv.self_ugx AS p_self, pv.agent_ugx AS p_agent, pv.self_all AS p_self_all, pv.agent_all AS p_agent_all,
           CASE WHEN pv.self_ugx + pv.agent_ugx > 0 THEN pv.self_ugx / (pv.self_ugx + pv.agent_ugx)
                WHEN pv.self_all + pv.agent_all > 0 THEN pv.self_all / (pv.self_all + pv.agent_all) END AS p_share
    FROM t t0 LEFT JOIN prev pv ON pv.tn = t0.tn
  ),
  beh AS (
    SELECT s.*,
      CASE
        WHEN s.self_share IS NULL THEN 'no_payment'
        WHEN s.self_share >= 0.8 THEN 'self_reliant'
        WHEN s.self_share >= 0.2 THEN 'hybrid'
        WHEN s.self_share > 0 THEN 'agent_led_some_self'
        ELSE 'agent_dependent'
      END AS bseg
    FROM ts s WHERE s.billed > 0 OR s.self_n + s.agent_n > 0
  ),
  beh_agg AS (
    SELECT b.bseg, count(*)::int AS tenants,
           COALESCE(SUM(b.billed), 0) AS billed, COALESCE(SUM(b.covered), 0) AS covered,
           COALESCE(SUM(b.self_ugx), 0) AS self_ugx, COALESCE(SUM(b.agent_ugx), 0) AS agent_ugx,
           round(AVG(b.day_ratio) * 100, 1) AS avg_paid_day_pct
    FROM beh b GROUP BY b.bseg
  ),
  shifts AS (
    SELECT b.*,
      CASE
        WHEN b.p_share IS NOT NULL AND b.self_share IS NOT NULL AND b.p_share >= 0.5 AND b.self_share <= b.p_share - 0.3 THEN 'moving_to_agents'
        WHEN b.p_share IS NOT NULL AND b.self_share IS NOT NULL AND b.p_share <= 0.2 AND b.self_share >= b.p_share + 0.3 THEN 'moving_to_self'
        WHEN COALESCE(b.p_self_all, 0) = 0 AND b.p_agent_all > 0 AND b.self_all > 0 THEN 'new_self_adopter'
        WHEN COALESCE(b.p_self_all, 0) > 0 AND COALESCE(b.self_all, 0) = 0 AND b.agent_all > 0 THEN 'moving_to_agents'
      END AS shift
    FROM beh b WHERE b.p_self_all IS NOT NULL OR b.self_all > 0
  ),
  shift_rows AS (
    SELECT s.shift, s.tn, COALESCE(NULLIF(trim(pr.full_name), ''), 'Unnamed tenant') AS nm, pr.phone,
           s.p_share, s.self_share, s.p_self, s.self_ugx, s.agent_ugx,
           (SELECT l.pl_agent FROM pl l WHERE l.pl_tenant = s.tn LIMIT 1) AS ag
    FROM shifts s LEFT JOIN public.profiles pr ON pr.id = s.tn
    WHERE s.shift IS NOT NULL
  ),
  cmp AS (
    SELECT
      CASE WHEN b.self_n > 0 THEN 'self_payers' WHEN b.agent_n > 0 THEN 'agent_only' END AS grp,
      b.cov, b.day_ratio
    FROM beh b WHERE b.billed > 0 AND (b.self_n > 0 OR b.agent_n > 0)
  ),
  cmp_agg AS (
    SELECT c.grp, count(*)::int AS n,
           AVG(c.cov) AS cov_mean, COALESCE(STDDEV_SAMP(c.cov), 0) AS cov_sd,
           AVG(c.day_ratio) AS dr_mean
    FROM cmp c WHERE c.grp IS NOT NULL GROUP BY c.grp
  ),
  cor AS (
    SELECT
      count(*) FILTER (WHERE b.self_share IS NOT NULL AND b.cov IS NOT NULL)::int AS n_cov,
      corr(b.self_share, b.cov) AS r_cov,
      count(*) FILTER (WHERE b.self_share IS NOT NULL AND b.day_ratio IS NOT NULL)::int AS n_dr,
      corr(b.self_share, b.day_ratio) AS r_dr,
      count(*) FILTER (WHERE b.self_share IS NOT NULL AND b.rent IS NOT NULL)::int AS n_rent,
      corr(b.self_share, b.rent) AS r_rent,
      count(*) FILTER (WHERE b.self_share IS NOT NULL AND b.plan_start IS NOT NULL)::int AS n_age,
      corr(b.self_share, (v_d2 - b.plan_start)::numeric) AS r_age,
      count(*) FILTER (WHERE b.self_share > 0)::int AS n_self
    FROM beh b
  )
  SELECT jsonb_build_object(
    'summary', v_summary,
    'segments', jsonb_build_object(
      'definition', 'Share of the tenant''s counted amount that came from their own payments: self reliant 80%+, hybrid 20-80%, agent led with some self-pay under 20%, agent dependent 0%, no payment = billed but nothing paid. Counted amount = payments up to the bill, as on Tenant Ops Home; a tenant who only paid ahead of the bill is placed by the share of what they paid.',
      'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'segment', g.bseg, 'tenants', g.tenants, 'billed_ugx', g.billed, 'covered_ugx', g.covered,
          'short_ugx', g.billed - g.covered, 'coverage_pct', round(g.covered / NULLIF(g.billed, 0) * 100, 1),
          'self_ugx', g.self_ugx, 'agent_ugx', g.agent_ugx, 'avg_paid_day_pct', g.avg_paid_day_pct)
          ORDER BY CASE g.bseg WHEN 'self_reliant' THEN 1 WHEN 'hybrid' THEN 2 WHEN 'agent_led_some_self' THEN 3 WHEN 'agent_dependent' THEN 4 ELSE 5 END)
          FROM beh_agg g), '[]'::jsonb)
    ),
    'shift', jsonb_build_object(
      'definition', 'Each tenant''s self-pay share of their counted amount now versus the previous window of the same length. Moving to agents: was 50%+ self and fell by 30 points or more (or stopped self-paying). Moving to self: was 20% or less and rose by 30 points or more. New self adopter: paid only through agents before, now pays themselves.',
      'previous_window', jsonb_build_object('start_day', (v_d1 - v_days), 'end_day', (v_d1 - 1)),
      'counts', COALESCE((SELECT jsonb_object_agg(r.shift, r.n) FROM (SELECT sr.shift, count(*)::int AS n FROM shift_rows sr GROUP BY sr.shift) r), '{}'::jsonb),
      'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'shift', r.shift, 'tenant_id', r.tn, 'tenant_name', r.nm, 'tenant_phone', r.phone,
          'agent_id', r.ag, 'previous_self_share_pct', round(r.p_share * 100, 1), 'self_share_pct', round(r.self_share * 100, 1),
          'self_ugx', r.self_ugx, 'agent_ugx', r.agent_ugx)
          ORDER BY CASE r.shift WHEN 'moving_to_agents' THEN 1 ELSE 2 END, r.agent_ugx DESC)
          FROM (SELECT * FROM shift_rows ORDER BY agent_ugx DESC LIMIT 200) r), '[]'::jsonb)
    ),
    'comparison', jsonb_build_object(
      'definition', 'Average coverage of the bill for tenants who paid at least once themselves versus tenants paid for only by agents. Observational: tenants choose how to pay, so a difference is not proof that self-paying causes better payment.',
      'self_payers', (SELECT jsonb_build_object('tenants', a.n, 'coverage_pct', round(a.cov_mean * 100, 1), 'paid_day_pct', round(a.dr_mean * 100, 1)) FROM cmp_agg a WHERE a.grp = 'self_payers'),
      'agent_only', (SELECT jsonb_build_object('tenants', a.n, 'coverage_pct', round(a.cov_mean * 100, 1), 'paid_day_pct', round(a.dr_mean * 100, 1)) FROM cmp_agg a WHERE a.grp = 'agent_only'),
      'difference_pp', (SELECT round((s.cov_mean - g.cov_mean) * 100, 1) FROM cmp_agg s, cmp_agg g WHERE s.grp = 'self_payers' AND g.grp = 'agent_only'),
      'margin_pp_95', (SELECT round(1.96 * sqrt(power(s.cov_sd, 2) / NULLIF(s.n, 0) + power(g.cov_sd, 2) / NULLIF(g.n, 0)) * 100, 1) FROM cmp_agg s, cmp_agg g WHERE s.grp = 'self_payers' AND g.grp = 'agent_only'),
      'enough_data', COALESCE((SELECT bool_and(a.n >= 10) AND count(*) = 2 FROM cmp_agg a), false)
    ),
    'correlations', jsonb_build_object(
      'definition', 'Pearson correlation across tenants. Close to 0 means no relationship; +1 or -1 a strong one. It shows association, not cause.',
      'tenants_with_self_pay', (SELECT c.n_self FROM cor c),
      'enough_data', (SELECT c.n_self >= 10 AND c.n_cov >= 30 FROM cor c),
      'pairs', jsonb_build_array(
        (SELECT jsonb_build_object('key', 'self_share_vs_coverage', 'label', 'Self-pay share vs % of bill covered', 'r', round(c.r_cov::numeric, 2), 'n', c.n_cov) FROM cor c),
        (SELECT jsonb_build_object('key', 'self_share_vs_paid_days', 'label', 'Self-pay share vs share of billed days paid', 'r', round(c.r_dr::numeric, 2), 'n', c.n_dr) FROM cor c),
        (SELECT jsonb_build_object('key', 'self_share_vs_rent', 'label', 'Self-pay share vs rent level', 'r', round(c.r_rent::numeric, 2), 'n', c.n_rent) FROM cor c),
        (SELECT jsonb_build_object('key', 'self_share_vs_plan_age', 'label', 'Self-pay share vs Rent Plan age', 'r', round(c.r_age::numeric, 2), 'n', c.n_age) FROM cor c)
      )
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_payment_behaviour_overview_v2(timestamptz, timestamptz, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_payment_behaviour_overview_v2(timestamptz, timestamptz, uuid, text, text, text) TO authenticated;

-- ─── trend_v2 ───────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tops_payment_behaviour_trend_v2(
  p_start timestamptz,
  p_end timestamptz,
  p_agent_id uuid DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_cadence text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_d1 date := (p_start AT TIME ZONE 'Africa/Kampala')::date;
  v_d2 date := (p_end AT TIME ZONE 'Africa/Kampala')::date;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_asof date;
  v_bucket text;
  v_first_self date;
  v_wk_from date;
  v_wk_last date;
  v_series jsonb;
  v_ahead jsonb;
  v_proj jsonb;
  v_n int;
  v_slope numeric;
  v_icpt numeric;
  v_r2 numeric;
  v_slope_ugx numeric;
  v_icpt_ugx numeric;
  v_last_x int;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  v_asof := LEAST(v_d2, v_today);
  v_bucket := CASE WHEN (v_d2 - v_d1) + 1 <= 45 THEN 'day' WHEN (v_d2 - v_d1) + 1 <= 200 THEN 'week' ELSE 'month' END;

  WITH pay AS MATERIALIZED (
    SELECT p.*, date_trunc(v_bucket, p.pay_day::timestamp)::date AS b
    FROM public.tops_pay_behaviour_payments_capped(p_start, p_end, p_agent_id, p_region, p_district, p_cadence) p
  ),
  buckets AS (
    SELECT gs::date AS b
    FROM generate_series(date_trunc(v_bucket, v_d1::timestamp), v_d2::timestamp,
                         CASE v_bucket WHEN 'day' THEN interval '1 day' WHEN 'week' THEN interval '1 week' ELSE interval '1 month' END) gs
  ),
  agg AS (
    SELECT y.b,
           COALESCE(SUM(y.pay_counted_ugx) FILTER (WHERE y.pay_channel = 'self'), 0) AS self_ugx,
           COALESCE(SUM(y.pay_counted_ugx) FILTER (WHERE y.pay_channel = 'agent'), 0) AS agent_ugx,
           COALESCE(SUM(y.pay_counted_ugx) FILTER (WHERE y.pay_channel = 'other'), 0) AS other_ugx,
           COALESCE(SUM(y.pay_excess_ugx), 0) AS ahead_ugx,
           count(*) FILTER (WHERE y.pay_excess_ugx > 0)::int AS ahead_n,
           count(*) FILTER (WHERE y.pay_channel = 'self')::int AS self_n,
           count(*) FILTER (WHERE y.pay_channel = 'agent')::int AS agent_n,
           count(DISTINCT y.pay_tenant) FILTER (WHERE y.pay_channel = 'self')::int AS self_tenants,
           count(DISTINCT y.pay_tenant) FILTER (WHERE y.pay_channel = 'agent')::int AS agent_tenants,
           count(DISTINCT y.pay_tenant)::int AS paying_tenants
    FROM pay y GROUP BY y.b
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'bucket_start', k.b,
      'bucket_end', CASE v_bucket WHEN 'day' THEN k.b WHEN 'week' THEN k.b + 6 ELSE (k.b + interval '1 month' - interval '1 day')::date END,
      'partial', (CASE v_bucket WHEN 'day' THEN k.b WHEN 'week' THEN k.b + 6 ELSE (k.b + interval '1 month' - interval '1 day')::date END) >= v_today
                 OR k.b < v_d1,
      'self_ugx', COALESCE(a.self_ugx, 0), 'agent_ugx', COALESCE(a.agent_ugx, 0), 'other_ugx', COALESCE(a.other_ugx, 0),
      'paid_ahead_ugx', COALESCE(a.ahead_ugx, 0), 'paid_ahead_n', COALESCE(a.ahead_n, 0),
      'self_n', COALESCE(a.self_n, 0), 'agent_n', COALESCE(a.agent_n, 0),
      'self_tenants', COALESCE(a.self_tenants, 0), 'agent_tenants', COALESCE(a.agent_tenants, 0), 'paying_tenants', COALESCE(a.paying_tenants, 0),
      'self_share_pct', round(a.self_ugx / NULLIF(a.self_ugx + a.agent_ugx + a.other_ugx, 0) * 100, 1),
      'self_tenant_pct', round(a.self_tenants::numeric / NULLIF(a.paying_tenants, 0) * 100, 1)
    ) ORDER BY k.b), '[]'::jsonb)
  INTO v_series
  FROM buckets k LEFT JOIN agg a ON a.b = k.b;

  SELECT jsonb_build_object(
    'definition', 'Money paid above the Rent Plan bill for the period (or on plans with no bill). Not counted as collected, the same as Tenant Ops Home.',
    'paid_ahead_ugx', COALESCE(SUM(p.pay_excess_ugx), 0),
    'paid_ahead_n', count(*) FILTER (WHERE p.pay_excess_ugx > 0)::int,
    'self', jsonb_build_object('paid_ahead_ugx', COALESCE(SUM(p.pay_excess_ugx) FILTER (WHERE p.pay_channel = 'self'), 0),
                               'paid_ahead_n', count(*) FILTER (WHERE p.pay_excess_ugx > 0 AND p.pay_channel = 'self')::int),
    'agent', jsonb_build_object('paid_ahead_ugx', COALESCE(SUM(p.pay_excess_ugx) FILTER (WHERE p.pay_channel = 'agent'), 0),
                                'paid_ahead_n', count(*) FILTER (WHERE p.pay_excess_ugx > 0 AND p.pay_channel = 'agent')::int),
    'other', jsonb_build_object('paid_ahead_ugx', COALESCE(SUM(p.pay_excess_ugx) FILTER (WHERE p.pay_channel = 'other'), 0),
                                'paid_ahead_n', count(*) FILTER (WHERE p.pay_excess_ugx > 0 AND p.pay_channel = 'other')::int)
  ) INTO v_ahead
  FROM public.tops_pay_behaviour_payments_capped(p_start, p_end, p_agent_id, p_region, p_district, p_cadence) p;

  SELECT (MIN(ac.created_at) AT TIME ZONE 'Africa/Kampala')::date INTO v_first_self
  FROM public.agent_collections ac
  WHERE ac.collection_channel = 'tenant_deposit_auto' AND ac.amount > 0 AND ac.reversed_at IS NULL;

  v_wk_last := (v_asof - (extract(isodow FROM v_asof)::int % 7)) - 6;
  v_wk_from := GREATEST(v_wk_last - 77, COALESCE(date_trunc('week', v_first_self::timestamp)::date, v_wk_last));

  WITH wk AS (
    SELECT gs::date AS w FROM generate_series(v_wk_from::timestamp, v_wk_last::timestamp, interval '1 week') gs
  ),
  pay AS (
    SELECT date_trunc('week', p.pay_day::timestamp)::date AS w,
           COALESCE(SUM(p.pay_counted_ugx) FILTER (WHERE p.pay_channel = 'self'), 0) AS self_ugx,
           COALESCE(SUM(p.pay_counted_ugx), 0) AS all_ugx
    FROM public.tops_pay_behaviour_payments_capped(v_wk_from::timestamp AT TIME ZONE 'Africa/Kampala', (v_wk_last + 6)::timestamp AT TIME ZONE 'Africa/Kampala', p_agent_id, p_region, p_district, p_cadence) p
    GROUP BY 1
  ),
  s AS (
    SELECT row_number() OVER (ORDER BY wk.w) - 1 AS x, wk.w,
           COALESCE(pay.self_ugx, 0) AS self_ugx,
           COALESCE(pay.self_ugx / NULLIF(pay.all_ugx, 0) * 100, 0) AS share
    FROM wk LEFT JOIN pay ON pay.w = wk.w
  )
  SELECT count(*)::int, regr_slope(s.share, s.x), regr_intercept(s.share, s.x), regr_r2(s.share, s.x),
         regr_slope(s.self_ugx, s.x), regr_intercept(s.self_ugx, s.x), COALESCE(MAX(s.x), 0)::int
    INTO v_n, v_slope, v_icpt, v_r2, v_slope_ugx, v_icpt_ugx, v_last_x
  FROM s;

  IF v_n < 4 THEN
    v_proj := jsonb_build_object(
      'available', false,
      'weeks_used', v_n,
      'reason', 'Fewer than four complete weeks of self-payments exist for this selection, so no honest projection can be drawn.'
    );
  ELSE
    v_proj := jsonb_build_object(
      'available', true,
      'method', 'Straight-line fit of the weekly self-pay share (and self-paid UGX) over the complete weeks since the first self-payment, on counted amounts.',
      'estimate', true,
      'weeks_used', v_n,
      'first_week', v_wk_from,
      'last_week', v_wk_last,
      'slope_pp_per_week', round(v_slope, 2),
      'r_squared', round(COALESCE(v_r2, 0), 2),
      'confidence', CASE WHEN v_n >= 8 AND COALESCE(v_r2, 0) >= 0.5 THEN 'moderate' ELSE 'low' END,
      'projected', (SELECT jsonb_agg(jsonb_build_object(
          'week_start', (v_wk_last + 7 * i),
          'self_share_pct', round(LEAST(100, GREATEST(0, v_icpt + v_slope * (v_last_x + i))), 1),
          'self_ugx', round(GREATEST(0, v_icpt_ugx + v_slope_ugx * (v_last_x + i)), 0)) ORDER BY i)
          FROM generate_series(1, 4) i)
    );
  END IF;

  RETURN jsonb_build_object(
    'bucket', v_bucket,
    'window', jsonb_build_object('start_day', v_d1, 'end_day', v_d2, 'asof', v_asof),
    'points', v_series,
    'paid_ahead', v_ahead,
    'projection', v_proj
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_payment_behaviour_trend_v2(timestamptz, timestamptz, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_payment_behaviour_trend_v2(timestamptz, timestamptz, uuid, text, text, text) TO authenticated;

-- ─── timing_v2 ──────────────────────────────────────────────────────────────────
-- On-time versus late is worked out from rent_day_settlements (receipts settled against billed days), which is
-- already limited to billed days, so it is unchanged. The payment amount statistics use the counted amounts.

CREATE OR REPLACE FUNCTION public.tops_payment_behaviour_timing_v2(
  p_start timestamptz,
  p_end timestamptz,
  p_agent_id uuid DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_cadence text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  WITH pay AS MATERIALIZED (
    SELECT * FROM public.tops_pay_behaviour_payments_capped(p_start, p_end, p_agent_id, p_region, p_district, p_cadence)
  ),
  pl AS MATERIALIZED (
    SELECT * FROM public.tops_pay_behaviour_plans_capped(p_start, p_end, p_agent_id, p_region, p_district, p_cadence)
  ),
  chans AS (SELECT c.ch FROM (VALUES ('self'), ('agent')) c(ch)),
  st AS MATERIALIZED (
    SELECT y.pay_channel AS ch, y.pay_id, rs.amount AS amt, (y.pay_day - rs.day) AS lag
    FROM pay y JOIN public.rent_day_settlements rs ON rs.collection_id = y.pay_id
    WHERE y.pay_channel IN ('self', 'agent')
  ),
  st_b AS (
    SELECT s.ch,
           CASE WHEN s.lag < 0 THEN 'ahead' WHEN s.lag = 0 THEN 'same_day' WHEN s.lag <= 3 THEN 'late_1_3'
                WHEN s.lag <= 7 THEN 'late_4_7' WHEN s.lag <= 14 THEN 'late_8_14' ELSE 'late_15_plus' END AS bk,
           count(*)::int AS n, SUM(s.amt) AS ugx, count(DISTINCT s.pay_id)::int AS receipts
    FROM st s GROUP BY 1, 2
  ),
  st_t AS (
    SELECT s.ch,
           SUM(s.amt) AS ugx, count(*)::int AS n,
           SUM(s.amt) FILTER (WHERE s.lag <= 0) AS on_time_ugx,
           count(*) FILTER (WHERE s.lag <= 0)::int AS on_time_n,
           round(AVG(GREATEST(s.lag, 0)) FILTER (WHERE s.lag > 0), 1) AS avg_late_days,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY s.lag))::numeric AS median_lag,
           count(DISTINCT s.pay_id)::int AS receipts
    FROM st s GROUP BY s.ch
  ),
  cov AS (
    SELECT count(*) FILTER (WHERE y.pay_channel IN ('self', 'agent'))::int AS receipts,
           count(*) FILTER (WHERE y.pay_channel IN ('self', 'agent') AND EXISTS (SELECT 1 FROM public.rent_day_settlements r WHERE r.collection_id = y.pay_id))::int AS with_detail
    FROM pay y
  ),
  fr AS (
    SELECT l.pl_segment AS seg, count(*)::int AS plans,
           round(AVG(LEAST(1.0, l.pl_paid_days::numeric / l.pl_billed_days)) * 100, 1) AS paid_day_pct,
           count(*) FILTER (WHERE l.pl_paid_days::numeric / l.pl_billed_days >= 0.8)::int AS consistent,
           count(*) FILTER (WHERE l.pl_paid_days::numeric / l.pl_billed_days >= 0.4 AND l.pl_paid_days::numeric / l.pl_billed_days < 0.8)::int AS patchy,
           count(*) FILTER (WHERE l.pl_paid_days::numeric / l.pl_billed_days < 0.4)::int AS sporadic
    FROM pl l WHERE l.pl_billed_days > 0 GROUP BY l.pl_segment
  ),
  days AS (
    SELECT DISTINCT y.pay_tenant AS tn, y.pay_channel AS ch, y.pay_day AS d FROM pay y WHERE y.pay_channel IN ('self', 'agent')
  ),
  gaps AS (
    SELECT x.ch, (x.d - x.prev_d) AS gap
    FROM (SELECT dd.ch, dd.d, lag(dd.d) OVER (PARTITION BY dd.tn, dd.ch ORDER BY dd.d) AS prev_d FROM days dd) x
    WHERE x.prev_d IS NOT NULL
  ),
  gap_agg AS (
    SELECT g.ch, count(*)::int AS n, round(AVG(g.gap), 1) AS avg_gap, (percentile_cont(0.5) WITHIN GROUP (ORDER BY g.gap))::numeric AS median_gap
    FROM gaps g GROUP BY g.ch
  ),
  per_t AS (
    SELECT y.pay_channel AS ch, y.pay_tenant AS tn, count(*)::int AS n, count(DISTINCT y.pay_day)::int AS pdays
    FROM pay y WHERE y.pay_channel IN ('self', 'agent') GROUP BY 1, 2
  ),
  per_t_agg AS (
    SELECT p.ch, count(*)::int AS tenants, round(AVG(p.n), 1) AS avg_payments, round(AVG(p.pdays), 1) AS avg_pay_days
    FROM per_t p GROUP BY p.ch
  ),
  amt AS (
    SELECT y.pay_channel AS ch,
           count(*) FILTER (WHERE y.pay_counted_ugx > 0)::int AS n,
           count(*)::int AS all_n,
           round(AVG(y.pay_counted_ugx) FILTER (WHERE y.pay_counted_ugx > 0), 0) AS avg_ugx,
           round((percentile_cont(ARRAY[0.1, 0.25, 0.5, 0.75, 0.9]) WITHIN GROUP (ORDER BY y.pay_counted_ugx) FILTER (WHERE y.pay_counted_ugx > 0))[1]::numeric, 0) AS p10,
           round((percentile_cont(ARRAY[0.1, 0.25, 0.5, 0.75, 0.9]) WITHIN GROUP (ORDER BY y.pay_counted_ugx) FILTER (WHERE y.pay_counted_ugx > 0))[2]::numeric, 0) AS p25,
           round((percentile_cont(ARRAY[0.1, 0.25, 0.5, 0.75, 0.9]) WITHIN GROUP (ORDER BY y.pay_counted_ugx) FILTER (WHERE y.pay_counted_ugx > 0))[3]::numeric, 0) AS p50,
           round((percentile_cont(ARRAY[0.1, 0.25, 0.5, 0.75, 0.9]) WITHIN GROUP (ORDER BY y.pay_counted_ugx) FILTER (WHERE y.pay_counted_ugx > 0))[4]::numeric, 0) AS p75,
           round((percentile_cont(ARRAY[0.1, 0.25, 0.5, 0.75, 0.9]) WITHIN GROUP (ORDER BY y.pay_counted_ugx) FILTER (WHERE y.pay_counted_ugx > 0))[5]::numeric, 0) AS p90,
           MAX(y.pay_counted_ugx) AS max_ugx,
           COALESCE(SUM(y.pay_excess_ugx), 0) AS ahead_ugx,
           count(*) FILTER (WHERE y.pay_excess_ugx > 0)::int AS ahead_n
    FROM pay y WHERE y.pay_channel IN ('self', 'agent') GROUP BY y.pay_channel
  ),
  hrs AS (
    SELECT c.ch, h.h, count(y.pay_id)::int AS n
    FROM chans c CROSS JOIN generate_series(0, 23) h(h)
    LEFT JOIN pay y ON y.pay_channel = c.ch AND y.pay_hour = h.h
    GROUP BY c.ch, h.h
  ),
  dows AS (
    SELECT c.ch, d.d, count(y.pay_id)::int AS n
    FROM chans c CROSS JOIN generate_series(1, 7) d(d)
    LEFT JOIN pay y ON y.pay_channel = c.ch AND y.pay_dow = d.d
    GROUP BY c.ch, d.d
  ),
  med_hour AS (
    SELECT y.pay_channel AS ch, (percentile_cont(0.5) WITHIN GROUP (ORDER BY y.pay_hour))::numeric AS med
    FROM pay y WHERE y.pay_channel IN ('self', 'agent') GROUP BY y.pay_channel
  ),
  ahead_tot AS (
    SELECT COALESCE(SUM(y.pay_excess_ugx), 0) AS ugx,
           count(*) FILTER (WHERE y.pay_excess_ugx > 0)::int AS n,
           COALESCE(SUM(y.pay_excess_ugx) FILTER (WHERE y.pay_channel = 'self'), 0) AS self_ugx,
           count(*) FILTER (WHERE y.pay_excess_ugx > 0 AND y.pay_channel = 'self')::int AS self_n,
           COALESCE(SUM(y.pay_excess_ugx) FILTER (WHERE y.pay_channel = 'agent'), 0) AS agent_ugx,
           count(*) FILTER (WHERE y.pay_excess_ugx > 0 AND y.pay_channel = 'agent')::int AS agent_n,
           COALESCE(SUM(y.pay_excess_ugx) FILTER (WHERE y.pay_channel = 'other'), 0) AS other_ugx,
           count(*) FILTER (WHERE y.pay_excess_ugx > 0 AND y.pay_channel = 'other')::int AS other_n
    FROM pay y
  )
  SELECT jsonb_build_object(
    'on_time', jsonb_build_object(
      'definition', 'On time = the receipt was entered on or before the billed day it settled (paid on the day or ahead). Late = after it. From rent_day_settlements, which settles receipts against billed days first in, first out.',
      'settlement_detail_since', (SELECT MIN(r.day) FROM public.rent_day_settlements r),
      'receipts_in_window', (SELECT c.receipts FROM cov c),
      'receipts_with_detail', (SELECT c.with_detail FROM cov c),
      'detail_coverage_pct', (SELECT round(c.with_detail::numeric / NULLIF(c.receipts, 0) * 100, 1) FROM cov c),
      'by_channel', (SELECT jsonb_object_agg(c.ch, jsonb_build_object(
          'settled_ugx', COALESCE(t.ugx, 0), 'settled_days', COALESCE(t.n, 0), 'receipts', COALESCE(t.receipts, 0),
          'on_time_ugx', COALESCE(t.on_time_ugx, 0),
          'on_time_pct', round(t.on_time_ugx / NULLIF(t.ugx, 0) * 100, 1),
          'late_pct', round((t.ugx - t.on_time_ugx) / NULLIF(t.ugx, 0) * 100, 1),
          'on_time_days_pct', round(t.on_time_n::numeric / NULLIF(t.n, 0) * 100, 1),
          'avg_days_late_when_late', t.avg_late_days,
          'median_days_vs_due', round(t.median_lag, 1),
          'buckets', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', k.key, 'settled_ugx', COALESCE(b.ugx, 0), 'settled_pct', round(COALESCE(b.ugx, 0) / NULLIF(t.ugx, 0) * 100, 1), 'settled_days', COALESCE(b.n, 0), 'receipts', COALESCE(b.receipts, 0)) ORDER BY k.o)
                               FROM (VALUES (1, 'ahead'), (2, 'same_day'), (3, 'late_1_3'), (4, 'late_4_7'), (5, 'late_8_14'), (6, 'late_15_plus')) k(o, key)
                               LEFT JOIN st_b b ON b.ch = c.ch AND b.bk = k.key), '[]'::jsonb)))
          FROM chans c LEFT JOIN st_t t ON t.ch = c.ch)
    ),
    'frequency', jsonb_build_object(
      'definition', 'Share of billed days on which the Rent Plan received a payment. Consistent = 80%+ of billed days, patchy = 40-80%, sporadic = under 40%.',
      'by_segment', COALESCE((SELECT jsonb_agg(jsonb_build_object('segment', f.seg, 'plans', f.plans, 'paid_day_pct', f.paid_day_pct,
          'consistent', f.consistent, 'patchy', f.patchy, 'sporadic', f.sporadic)
          ORDER BY CASE f.seg WHEN 'self_only' THEN 1 WHEN 'mixed' THEN 2 WHEN 'agent_only' THEN 3 ELSE 4 END) FROM fr f), '[]'::jsonb),
      'by_channel', (SELECT jsonb_object_agg(c.ch, jsonb_build_object(
          'tenants', COALESCE(pa.tenants, 0), 'avg_payments_per_tenant', pa.avg_payments, 'avg_pay_days_per_tenant', pa.avg_pay_days,
          'gaps_measured', COALESCE(ga.n, 0), 'avg_days_between_payments', ga.avg_gap, 'median_days_between_payments', round(ga.median_gap, 1)))
          FROM chans c LEFT JOIN per_t_agg pa ON pa.ch = c.ch LEFT JOIN gap_agg ga ON ga.ch = c.ch)
    ),
    'amounts', (SELECT jsonb_object_agg(a.ch, jsonb_build_object('n', a.n, 'all_n', a.all_n, 'avg_ugx', a.avg_ugx, 'p10', a.p10, 'p25', a.p25, 'median_ugx', a.p50, 'p75', a.p75, 'p90', a.p90, 'max_ugx', a.max_ugx, 'paid_ahead_ugx', a.ahead_ugx, 'paid_ahead_n', a.ahead_n)) FROM amt a),
    'paid_ahead', (SELECT jsonb_build_object(
        'definition', 'Money paid above the Rent Plan bill for the period (or on plans with no bill). Not counted as collected, the same as Tenant Ops Home. Amount statistics above use counted money on payments that contributed to it.',
        'paid_ahead_ugx', t.ugx, 'paid_ahead_n', t.n,
        'self', jsonb_build_object('paid_ahead_ugx', t.self_ugx, 'paid_ahead_n', t.self_n),
        'agent', jsonb_build_object('paid_ahead_ugx', t.agent_ugx, 'paid_ahead_n', t.agent_n),
        'other', jsonb_build_object('paid_ahead_ugx', t.other_ugx, 'paid_ahead_n', t.other_n)) FROM ahead_tot t),
    'clock', jsonb_build_object(
      'median_hour', (SELECT jsonb_object_agg(m.ch, round(m.med, 1)) FROM med_hour m),
      'hours', (SELECT jsonb_object_agg(c.ch, (SELECT jsonb_agg(h.n ORDER BY h.h) FROM hrs h WHERE h.ch = c.ch)) FROM chans c),
      'weekdays', (SELECT jsonb_object_agg(c.ch, (SELECT jsonb_agg(d.n ORDER BY d.d) FROM dows d WHERE d.ch = c.ch)) FROM chans c)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_payment_behaviour_timing_v2(timestamptz, timestamptz, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_payment_behaviour_timing_v2(timestamptz, timestamptz, uuid, text, text, text) TO authenticated;

-- ─── by_v2 ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tops_payment_behaviour_by_v2(
  p_start timestamptz,
  p_end timestamptz,
  p_dimension text,
  p_agent_id uuid DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_cadence text DEFAULT NULL,
  p_limit int DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 300), 1), 1000);
  v_result jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  IF p_dimension IS NULL OR p_dimension NOT IN ('agent', 'region', 'district', 'rent_band', 'cadence', 'cohort') THEN
    RAISE EXCEPTION 'invalid dimension: %, expected agent/region/district/rent_band/cadence/cohort', p_dimension;
  END IF;

  WITH pl AS MATERIALIZED (
    SELECT * FROM public.tops_pay_behaviour_plans_capped(p_start, p_end, p_agent_id, p_region, p_district, p_cadence)
  ),
  keyed AS (
    SELECT
      CASE p_dimension
        WHEN 'agent' THEN COALESCE(l.pl_agent::text, 'none')
        WHEN 'region' THEN COALESCE(tb.region, 'Unmapped')
        WHEN 'district' THEN COALESCE(tb.district_name, 'Unmapped')
        WHEN 'rent_band' THEN
          CASE WHEN l.pl_rent IS NULL THEN 'unknown' WHEN l.pl_rent < 150000 THEN 'a_lt_150k' WHEN l.pl_rent < 300000 THEN 'b_150_300k'
               WHEN l.pl_rent < 500000 THEN 'c_300_500k' WHEN l.pl_rent < 1000000 THEN 'd_500k_1m' ELSE 'e_1m_plus' END
        WHEN 'cadence' THEN COALESCE(l.pl_cadence, 'unknown')
        WHEN 'cohort' THEN COALESCE(to_char(l.pl_start, 'YYYY-MM'), 'unknown')
      END AS k,
      l.*
    FROM pl l
    LEFT JOIN public.v_tlb_tenant_base tb ON p_dimension IN ('region', 'district') AND tb.tenant_id = l.pl_tenant
  ),
  agg AS (
    SELECT
      x.k,
      count(DISTINCT x.pl_tenant) FILTER (WHERE x.pl_paid_ugx > 0 OR x.pl_ahead_ugx > 0)::int AS paying,
      count(DISTINCT x.pl_tenant) FILTER (WHERE x.pl_billed_ugx > 0)::int AS billed_tenants,
      count(DISTINCT x.pl_tenant) FILTER (WHERE x.pl_self_n > 0)::int AS self_payers,
      count(DISTINCT x.pl_tenant) FILTER (WHERE x.pl_segment = 'self_only')::int AS self_only,
      count(DISTINCT x.pl_tenant) FILTER (WHERE x.pl_segment = 'agent_only')::int AS agent_only,
      count(DISTINCT x.pl_tenant) FILTER (WHERE x.pl_segment = 'mixed')::int AS mixed,
      count(*)::int AS plans,
      SUM(x.pl_self_ugx) AS self_ugx, SUM(x.pl_agent_ugx) AS agent_ugx, SUM(x.pl_other_ugx) AS other_ugx,
      SUM(x.pl_ahead_ugx) AS ahead_ugx, SUM(x.pl_ahead_self_ugx) AS ahead_self_ugx, SUM(x.pl_ahead_agent_ugx) AS ahead_agent_ugx,
      SUM(x.pl_ahead_n)::int AS ahead_n,
      SUM(x.pl_billed_ugx) AS billed, SUM(x.pl_covered_ugx) AS covered,
      SUM(x.pl_billed_ugx) FILTER (WHERE x.pl_self_n > 0) AS self_billed,
      SUM(x.pl_covered_ugx) FILTER (WHERE x.pl_self_n > 0) AS self_covered,
      SUM(x.pl_billed_ugx) FILTER (WHERE x.pl_segment = 'agent_only') AS ag_billed,
      SUM(x.pl_covered_ugx) FILTER (WHERE x.pl_segment = 'agent_only') AS ag_covered
    FROM keyed x GROUP BY x.k
  ),
  labelled AS (
    SELECT a.*,
      CASE p_dimension
        WHEN 'agent' THEN COALESCE(NULLIF(trim(pr.full_name), ''), CASE WHEN a.k = 'none' THEN 'No agent' ELSE 'Unnamed agent' END)
        WHEN 'rent_band' THEN CASE a.k WHEN 'a_lt_150k' THEN 'Under UGX 150,000' WHEN 'b_150_300k' THEN 'UGX 150,000 - 300,000'
                WHEN 'c_300_500k' THEN 'UGX 300,000 - 500,000' WHEN 'd_500k_1m' THEN 'UGX 500,000 - 1,000,000'
                WHEN 'e_1m_plus' THEN 'UGX 1,000,000 and above' ELSE 'Unknown rent' END
        WHEN 'cadence' THEN CASE a.k WHEN 'daily' THEN 'Daily' WHEN 'weekly' THEN 'Weekly' WHEN 'monthly' THEN 'Monthly' ELSE initcap(a.k) END
        WHEN 'cohort' THEN CASE WHEN a.k = 'unknown' THEN 'Unknown start' ELSE to_char(to_date(a.k || '-01', 'YYYY-MM-DD'), 'Mon YYYY') END
        ELSE a.k
      END AS label
    FROM agg a
    LEFT JOIN public.profiles pr ON p_dimension = 'agent' AND a.k <> 'none' AND pr.id::text = a.k
    WHERE a.billed > 0 OR a.paying > 0
  )
  SELECT jsonb_build_object(
    'dimension', p_dimension,
    'paid_ahead', (SELECT jsonb_build_object(
        'paid_ahead_ugx', COALESCE(SUM(l.pl_ahead_ugx), 0), 'paid_ahead_n', COALESCE(SUM(l.pl_ahead_n), 0)::int,
        'self', jsonb_build_object('paid_ahead_ugx', COALESCE(SUM(l.pl_ahead_self_ugx), 0), 'paid_ahead_n', COALESCE(SUM(l.pl_ahead_self_n), 0)::int),
        'agent', jsonb_build_object('paid_ahead_ugx', COALESCE(SUM(l.pl_ahead_agent_ugx), 0), 'paid_ahead_n', COALESCE(SUM(l.pl_ahead_agent_n), 0)::int)
      ) FROM pl l),
    'rows', COALESCE((SELECT jsonb_agg(r.j ORDER BY CASE WHEN p_dimension IN ('rent_band', 'cohort', 'cadence') THEN r.k END ASC, r.paying DESC, r.k) FROM (
      SELECT l.k, l.paying, jsonb_build_object(
        'key', l.k, 'label', l.label, 'plans', l.plans, 'billed_tenants', l.billed_tenants, 'paying_tenants', l.paying,
        'self_payers', l.self_payers, 'self_payers_pct', round(l.self_payers::numeric / NULLIF(l.paying, 0) * 100, 1),
        'self_only', l.self_only, 'agent_only', l.agent_only, 'mixed', l.mixed,
        'self_ugx', l.self_ugx, 'agent_ugx', l.agent_ugx,
        'paid_ahead_ugx', l.ahead_ugx, 'paid_ahead_n', l.ahead_n,
        'paid_ahead_self_ugx', l.ahead_self_ugx, 'paid_ahead_agent_ugx', l.ahead_agent_ugx,
        'self_share_pct', round(l.self_ugx / NULLIF(l.self_ugx + l.agent_ugx + l.other_ugx, 0) * 100, 1),
        'billed_ugx', l.billed, 'covered_ugx', l.covered, 'short_ugx', l.billed - l.covered,
        'coverage_pct', round(l.covered / NULLIF(l.billed, 0) * 100, 1),
        'self_payers_coverage_pct', round(l.self_covered / NULLIF(l.self_billed, 0) * 100, 1),
        'agent_only_coverage_pct', round(l.ag_covered / NULLIF(l.ag_billed, 0) * 100, 1)
      ) AS j
      FROM labelled l
      ORDER BY l.paying DESC, l.k
      LIMIT v_limit) r), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_payment_behaviour_by_v2(timestamptz, timestamptz, text, uuid, text, text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_payment_behaviour_by_v2(timestamptz, timestamptz, text, uuid, text, text, text, int) TO authenticated;

-- ─── watchlist_v2 ───────────────────────────────────────────────────────────────
-- The warning signs and the back-test already measure the bill week by week (LEAST(paid, billed)), so the rules
-- are unchanged. What changes is the money shown on each row: paid in the last 7 days and the 7 before are
-- capped at what was billed in those days, and the 28-day self and agent amounts are counted amounts
-- (28 days to the as-of day, bill shared oldest payment first), with the rest as paid ahead.

CREATE OR REPLACE FUNCTION public.tops_payment_behaviour_watchlist_v2(
  p_start timestamptz,
  p_end timestamptz,
  p_agent_id uuid DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_cadence text DEFAULT NULL,
  p_min_score integer DEFAULT 1,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_asof date;
  v_cut date;
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_min int := LEAST(GREATEST(COALESCE(p_min_score, 1), 0), 5);
  v_result jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  v_asof := LEAST((p_end AT TIME ZONE 'Africa/Kampala')::date, v_today);
  v_cut := v_asof - 7;

  WITH live AS MATERIALIZED (
    SELECT * FROM public.tops_pay_behaviour_flags(v_asof, p_agent_id, p_region, p_district, p_cadence)
  ),
  cap28 AS MATERIALIZED (
    SELECT y.pay_rr AS rr_id,
           COALESCE(SUM(y.pay_counted_ugx) FILTER (WHERE y.pay_channel = 'self'), 0) AS self_c,
           COALESCE(SUM(y.pay_counted_ugx) FILTER (WHERE y.pay_channel = 'agent'), 0) AS agent_c,
           COALESCE(SUM(y.pay_excess_ugx), 0) AS ahead_c,
           COALESCE(SUM(y.pay_excess_ugx) FILTER (WHERE y.pay_channel = 'self'), 0) AS ahead_self_c,
           COALESCE(SUM(y.pay_excess_ugx) FILTER (WHERE y.pay_channel = 'agent'), 0) AS ahead_agent_c,
           count(*) FILTER (WHERE y.pay_excess_ugx > 0)::int AS ahead_n_c
    FROM public.tops_pay_behaviour_payments_capped(
      ((v_asof - 27)::timestamp AT TIME ZONE 'Africa/Kampala'), (v_asof::timestamp AT TIME ZONE 'Africa/Kampala'),
      p_agent_id, p_region, p_district, p_cadence) y
    WHERE y.pay_rr IN (SELECT l0.fl_rr FROM live l0)
    GROUP BY y.pay_rr
  ),
  ranked AS (
    SELECT l.*, row_number() OVER (ORDER BY l.fl_score DESC, COALESCE(l.fl_behind_days, 0) DESC, l.fl_days_since DESC, l.fl_rr) AS rn,
           count(*) OVER () AS n_total
    FROM live l WHERE l.fl_score >= v_min
  ),
  page AS (
    SELECT r.*, COALESCE(NULLIF(trim(tp.full_name), ''), 'Unnamed tenant') AS tn_name, tp.phone AS tn_phone,
           COALESCE(NULLIF(trim(ap.full_name), ''), 'Unnamed agent') AS ag_name, ap.phone AS ag_phone,
           tb.region AS rgn, tb.district_name AS dst,
           COALESCE(c.self_c, 0) AS self_c, COALESCE(c.agent_c, 0) AS agent_c, COALESCE(c.ahead_c, 0) AS ahead_c, COALESCE(c.ahead_n_c, 0) AS ahead_n_c
    FROM ranked r
    LEFT JOIN public.profiles tp ON tp.id = r.fl_tenant
    LEFT JOIN public.profiles ap ON ap.id = r.fl_agent
    LEFT JOIN public.v_tlb_tenant_base tb ON tb.tenant_id = r.fl_tenant
    LEFT JOIN cap28 c ON c.rr_id = r.fl_rr
    WHERE r.rn > v_offset AND r.rn <= v_offset + v_limit
  ),
  cut AS MATERIALIZED (
    SELECT * FROM public.tops_pay_behaviour_flags(v_cut, p_agent_id, p_region, p_district, p_cadence)
  ),
  hb AS (
    SELECT dp.rent_request_id AS rr_id, SUM(dp.expected_ugx) AS bills
    FROM public.agent_expected_day_plans dp
    WHERE dp.day BETWEEN v_cut + 1 AND v_asof AND dp.rent_request_id IN (SELECT c.fl_rr FROM cut c)
    GROUP BY dp.rent_request_id
  ),
  hp AS (
    SELECT y.pay_rr AS rr_id, SUM(y.pay_amount) AS paid
    FROM public.tops_pay_behaviour_payments(((v_cut + 1)::timestamp AT TIME ZONE 'Africa/Kampala'), (v_asof::timestamp AT TIME ZONE 'Africa/Kampala'), p_agent_id, p_region, p_district, p_cadence) y
    GROUP BY y.pay_rr
  ),
  bt AS (
    SELECT c.*, (LEAST(COALESCE(p.paid, 0), b.bills) < 0.5 * b.bills) AS missed
    FROM cut c JOIN hb b ON b.rr_id = c.fl_rr AND b.bills > 0 LEFT JOIN hp p ON p.rr_id = c.fl_rr
  ),
  bt_score AS (
    SELECT CASE WHEN t.fl_score >= 3 THEN '3+' ELSE t.fl_score::text END AS g,
           count(*)::int AS plans, count(*) FILTER (WHERE t.missed)::int AS missed
    FROM bt t GROUP BY 1
  ),
  bt_flag AS (
    SELECT f.flag,
           count(*) FILTER (WHERE f.fon)::int AS fl_n, count(*) FILTER (WHERE f.fon AND f.fmissed)::int AS fl_missed,
           count(*) FILTER (WHERE NOT f.fon)::int AS un_n, count(*) FILTER (WHERE NOT f.fon AND f.fmissed)::int AS un_missed
    FROM bt t
    CROSS JOIN LATERAL (VALUES ('silent', t.f_silent, t.missed), ('slipping', t.f_slipping, t.missed), ('behind', t.f_behind, t.missed),
                               ('moving_to_agent', t.f_to_agent, t.missed), ('refused_attempt', t.f_refused, t.missed)) f(flag, fon, fmissed)
    GROUP BY f.flag
  ),
  bt_tot AS (
    SELECT count(*)::int AS plans, count(*) FILTER (WHERE t.missed)::int AS missed,
           count(*) FILTER (WHERE t.fl_score = 0)::int AS z_plans, count(*) FILTER (WHERE t.fl_score = 0 AND t.missed)::int AS z_missed,
           count(*) FILTER (WHERE t.fl_score >= 2)::int AS h_plans, count(*) FILTER (WHERE t.fl_score >= 2 AND t.missed)::int AS h_missed
    FROM bt t
  )
  SELECT jsonb_build_object(
    'asof', v_asof,
    'definition', 'Five rule-based warning signs worked out from what had been recorded by the as-of day: silent (no payment for max(3 days, twice the usual gap)), slipping (last 7 days cover 30+ points less of the bill than the 7 before), behind (7+ days behind, first in first out), moving to agents (was 50%+ self-paying, now 20% or less), refused attempt (tried to self-pay and was refused). Score = how many apply.',
    'summary', (SELECT jsonb_build_object(
        'plans_scored', count(*)::int,
        'score_0', count(*) FILTER (WHERE l.fl_score = 0)::int,
        'score_1', count(*) FILTER (WHERE l.fl_score = 1)::int,
        'score_2', count(*) FILTER (WHERE l.fl_score = 2)::int,
        'score_3_plus', count(*) FILTER (WHERE l.fl_score >= 3)::int,
        'by_flag', jsonb_build_object(
          'silent', count(*) FILTER (WHERE l.f_silent)::int, 'slipping', count(*) FILTER (WHERE l.f_slipping)::int,
          'behind', count(*) FILTER (WHERE l.f_behind)::int, 'moving_to_agent', count(*) FILTER (WHERE l.f_to_agent)::int,
          'refused_attempt', count(*) FILTER (WHERE l.f_refused)::int),
        'paid_ahead_28d', jsonb_build_object(
          'paid_ahead_ugx', COALESCE((SELECT SUM(c.ahead_c) FROM cap28 c), 0),
          'paid_ahead_n', COALESCE((SELECT SUM(c.ahead_n_c) FROM cap28 c), 0)::int,
          'self', jsonb_build_object('paid_ahead_ugx', COALESCE((SELECT SUM(c.ahead_self_c) FROM cap28 c), 0)),
          'agent', jsonb_build_object('paid_ahead_ugx', COALESCE((SELECT SUM(c.ahead_agent_c) FROM cap28 c), 0)))
      ) FROM live l),
    'total', COALESCE((SELECT max(r.n_total) FROM ranked r), 0),
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'rent_request_id', p.fl_rr, 'plan_code', left(p.fl_rr::text, 8),
        'tenant_id', p.fl_tenant, 'tenant_name', p.tn_name, 'tenant_phone', p.tn_phone,
        'agent_id', p.fl_agent, 'agent_name', p.ag_name, 'agent_phone', p.ag_phone,
        'region', p.rgn, 'district', p.dst, 'cadence', p.fl_cadence, 'rent_ugx', p.fl_rent,
        'score', p.fl_score,
        'flags', to_jsonb(ARRAY_REMOVE(ARRAY[CASE WHEN p.f_silent THEN 'silent' END, CASE WHEN p.f_slipping THEN 'slipping' END,
                  CASE WHEN p.f_behind THEN 'behind' END, CASE WHEN p.f_to_agent THEN 'moving_to_agent' END,
                  CASE WHEN p.f_refused THEN 'refused_attempt' END], NULL)),
        'days_since_payment', p.fl_days_since, 'last_paid_day', p.fl_last_paid_day, 'median_gap_days', p.fl_med_gap,
        'days_behind', p.fl_behind_days,
        'billed_7d_ugx', p.fl_bills7, 'paid_7d_ugx', LEAST(p.fl_pay7, p.fl_bills7),
        'billed_prev_7d_ugx', p.fl_bills_prev7, 'paid_prev_7d_ugx', LEAST(p.fl_pay_prev7, p.fl_bills_prev7),
        'self_paid_28d_ugx', p.self_c, 'agent_paid_28d_ugx', p.agent_c,
        'paid_ahead_28d_ugx', p.ahead_c, 'paid_ahead_28d_n', p.ahead_n_c
      ) ORDER BY p.rn) FROM page p), '[]'::jsonb),
    'backtest', (SELECT jsonb_build_object(
        'estimate', true,
        'cutoff_day', v_cut,
        'outcome_window', jsonb_build_object('start_day', v_cut + 1, 'end_day', v_asof),
        'missed_definition', 'Billed in the 7 days after the cutoff and covered less than half of that bill.',
        'plans', t.plans, 'missed', t.missed,
        'missed_pct', round(t.missed::numeric / NULLIF(t.plans, 0) * 100, 1),
        'no_signs_plans', t.z_plans, 'no_signs_missed_pct', round(t.z_missed::numeric / NULLIF(t.z_plans, 0) * 100, 1),
        'two_plus_signs_plans', t.h_plans, 'two_plus_signs_missed_pct', round(t.h_missed::numeric / NULLIF(t.h_plans, 0) * 100, 1),
        'enough_data', (t.plans >= 100 AND t.h_plans >= 20 AND t.z_plans >= 20),
        'by_score', COALESCE((SELECT jsonb_agg(jsonb_build_object('score', s.g, 'plans', s.plans, 'missed', s.missed,
              'missed_pct', round(s.missed::numeric / NULLIF(s.plans, 0) * 100, 1)) ORDER BY s.g) FROM bt_score s), '[]'::jsonb),
        'by_flag', COALESCE((SELECT jsonb_agg(jsonb_build_object('flag', f.flag, 'flagged_plans', f.fl_n,
              'flagged_missed_pct', round(f.fl_missed::numeric / NULLIF(f.fl_n, 0) * 100, 1),
              'unflagged_plans', f.un_n, 'unflagged_missed_pct', round(f.un_missed::numeric / NULLIF(f.un_n, 0) * 100, 1))
              ORDER BY f.flag) FROM bt_flag f), '[]'::jsonb)
      ) FROM bt_tot t)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_payment_behaviour_watchlist_v2(timestamptz, timestamptz, uuid, text, text, text, integer, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_payment_behaviour_watchlist_v2(timestamptz, timestamptz, uuid, text, text, text, integer, integer, integer) TO authenticated;

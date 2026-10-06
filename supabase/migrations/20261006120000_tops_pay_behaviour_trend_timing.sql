-- Tenant Payment Behavior: the trend over time (with a clearly-labelled estimate of the next four
-- weeks) and the timing / frequency / on-time analysis. Additive, read-only; builds on
-- tops_pay_behaviour_payments / _plans (see 20261006100000).
--
-- tops_payment_behaviour_trend   one point per Kampala day (windows up to 45 days), week (up to 200
--                                days) or month: UGX and payment counts by who paid, distinct payers,
--                                and the self-pay share. The last bucket may still be moving
--                                (partial = true). 'projection' is an ESTIMATE: a straight-line fit
--                                of the weekly self-pay share (and amount) over up to the last 12
--                                complete weeks since the first self-payment, returned only when at
--                                least four weeks exist, with its slope, r-squared and confidence.
-- tops_payment_behaviour_timing  on time vs late (from rent_day_settlements, the system's own
--                                first-in-first-out record of which billed day each receipt paid),
--                                payment frequency and consistency, gaps between payments, payment
--                                size percentiles, hour of day and weekday, by who paid.
--
-- On time means the receipt was entered on or before the billed day it settled (paid on the day or
-- ahead); late means after it. rent_day_settlements only exists from the first pinned bill day
-- (2026-09-10), so the response carries the share of the window's receipts that have settlement
-- detail, and the screen says so.

CREATE OR REPLACE FUNCTION public.tops_payment_behaviour_trend(
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

  -- ─── series ───
  WITH pay AS MATERIALIZED (
    SELECT p.*, date_trunc(v_bucket, p.pay_day::timestamp)::date AS b
    FROM public.tops_pay_behaviour_payments(p_start, p_end, p_agent_id, p_region, p_district, p_cadence) p
  ),
  buckets AS (
    SELECT gs::date AS b
    FROM generate_series(date_trunc(v_bucket, v_d1::timestamp), v_d2::timestamp,
                         CASE v_bucket WHEN 'day' THEN interval '1 day' WHEN 'week' THEN interval '1 week' ELSE interval '1 month' END) gs
  ),
  agg AS (
    SELECT y.b,
           COALESCE(SUM(y.pay_amount) FILTER (WHERE y.pay_channel = 'self'), 0) AS self_ugx,
           COALESCE(SUM(y.pay_amount) FILTER (WHERE y.pay_channel = 'agent'), 0) AS agent_ugx,
           COALESCE(SUM(y.pay_amount) FILTER (WHERE y.pay_channel = 'other'), 0) AS other_ugx,
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
      'self_n', COALESCE(a.self_n, 0), 'agent_n', COALESCE(a.agent_n, 0),
      'self_tenants', COALESCE(a.self_tenants, 0), 'agent_tenants', COALESCE(a.agent_tenants, 0), 'paying_tenants', COALESCE(a.paying_tenants, 0),
      'self_share_pct', round(a.self_ugx / NULLIF(a.self_ugx + a.agent_ugx + a.other_ugx, 0) * 100, 1),
      'self_tenant_pct', round(a.self_tenants::numeric / NULLIF(a.paying_tenants, 0) * 100, 1)
    ) ORDER BY k.b), '[]'::jsonb)
  INTO v_series
  FROM buckets k LEFT JOIN agg a ON a.b = k.b;

  -- ─── projection (estimate) ───
  SELECT (MIN(ac.created_at) AT TIME ZONE 'Africa/Kampala')::date INTO v_first_self
  FROM public.agent_collections ac
  WHERE ac.collection_channel = 'tenant_deposit_auto' AND ac.amount > 0 AND ac.reversed_at IS NULL;

  -- complete weeks only (Monday to Sunday ending on or before the as-of day), at most 12, none before the first self-payment week
  -- the most recent Sunday on or before the as-of day closes the last complete week
  v_wk_last := (v_asof - (extract(isodow FROM v_asof)::int % 7)) - 6;
  v_wk_from := GREATEST(v_wk_last - 77, COALESCE(date_trunc('week', v_first_self::timestamp)::date, v_wk_last));

  WITH wk AS (
    SELECT gs::date AS w FROM generate_series(v_wk_from::timestamp, v_wk_last::timestamp, interval '1 week') gs
  ),
  pay AS (
    SELECT date_trunc('week', p.pay_day::timestamp)::date AS w,
           COALESCE(SUM(p.pay_amount) FILTER (WHERE p.pay_channel = 'self'), 0) AS self_ugx,
           COALESCE(SUM(p.pay_amount), 0) AS all_ugx
    FROM public.tops_pay_behaviour_payments(v_wk_from::timestamp AT TIME ZONE 'Africa/Kampala', (v_wk_last + 6)::timestamp AT TIME ZONE 'Africa/Kampala', p_agent_id, p_region, p_district, p_cadence) p
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
      'method', 'Straight-line fit of the weekly self-pay share (and self-paid UGX) over the complete weeks since the first self-payment.',
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
    'projection', v_proj
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_payment_behaviour_trend(timestamptz, timestamptz, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_payment_behaviour_trend(timestamptz, timestamptz, uuid, text, text, text) TO authenticated;

-- ─── tops_payment_behaviour_timing ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tops_payment_behaviour_timing(
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
    SELECT * FROM public.tops_pay_behaviour_payments(p_start, p_end, p_agent_id, p_region, p_district, p_cadence)
  ),
  pl AS MATERIALIZED (
    SELECT * FROM public.tops_pay_behaviour_plans(p_start, p_end, p_agent_id, p_region, p_district, p_cadence)
  ),
  chans AS (SELECT c.ch FROM (VALUES ('self'), ('agent')) c(ch)),
  -- on time / late, one row per settled billed day
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
  -- frequency and consistency: share of billed days that saw a payment, by segment
  fr AS (
    SELECT l.pl_segment AS seg, count(*)::int AS plans,
           round(AVG(LEAST(1.0, l.pl_paid_days::numeric / l.pl_billed_days)) * 100, 1) AS paid_day_pct,
           count(*) FILTER (WHERE l.pl_paid_days::numeric / l.pl_billed_days >= 0.8)::int AS consistent,
           count(*) FILTER (WHERE l.pl_paid_days::numeric / l.pl_billed_days >= 0.4 AND l.pl_paid_days::numeric / l.pl_billed_days < 0.8)::int AS patchy,
           count(*) FILTER (WHERE l.pl_paid_days::numeric / l.pl_billed_days < 0.4)::int AS sporadic
    FROM pl l WHERE l.pl_billed_days > 0 GROUP BY l.pl_segment
  ),
  -- gaps between a tenant's payment days, per channel
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
    SELECT y.pay_channel AS ch, count(*)::int AS n,
           round(AVG(y.pay_amount), 0) AS avg_ugx,
           round((percentile_cont(ARRAY[0.1, 0.25, 0.5, 0.75, 0.9]) WITHIN GROUP (ORDER BY y.pay_amount))[1]::numeric, 0) AS p10,
           round((percentile_cont(ARRAY[0.1, 0.25, 0.5, 0.75, 0.9]) WITHIN GROUP (ORDER BY y.pay_amount))[2]::numeric, 0) AS p25,
           round((percentile_cont(ARRAY[0.1, 0.25, 0.5, 0.75, 0.9]) WITHIN GROUP (ORDER BY y.pay_amount))[3]::numeric, 0) AS p50,
           round((percentile_cont(ARRAY[0.1, 0.25, 0.5, 0.75, 0.9]) WITHIN GROUP (ORDER BY y.pay_amount))[4]::numeric, 0) AS p75,
           round((percentile_cont(ARRAY[0.1, 0.25, 0.5, 0.75, 0.9]) WITHIN GROUP (ORDER BY y.pay_amount))[5]::numeric, 0) AS p90,
           MAX(y.pay_amount) AS max_ugx
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
    'amounts', (SELECT jsonb_object_agg(a.ch, jsonb_build_object('n', a.n, 'avg_ugx', a.avg_ugx, 'p10', a.p10, 'p25', a.p25, 'median_ugx', a.p50, 'p75', a.p75, 'p90', a.p90, 'max_ugx', a.max_ugx)) FROM amt a),
    'clock', jsonb_build_object(
      'median_hour', (SELECT jsonb_object_agg(m.ch, round(m.med, 1)) FROM med_hour m),
      'hours', (SELECT jsonb_object_agg(c.ch, (SELECT jsonb_agg(h.n ORDER BY h.h) FROM hrs h WHERE h.ch = c.ch)) FROM chans c),
      'weekdays', (SELECT jsonb_object_agg(c.ch, (SELECT jsonb_agg(d.n ORDER BY d.d) FROM dows d WHERE d.ch = c.ch)) FROM chans c)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_payment_behaviour_timing(timestamptz, timestamptz, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_payment_behaviour_timing(timestamptz, timestamptz, uuid, text, text, text) TO authenticated;

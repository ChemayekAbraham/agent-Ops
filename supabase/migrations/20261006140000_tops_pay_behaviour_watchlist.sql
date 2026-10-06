-- Tenant Payment Behavior: early-warning indicators and their back-test. Additive, read-only.
--
-- tops_pay_behaviour_flags(p_asof, ...)   one row per live Rent Plan (not completed or cancelled)
--   billed in the 14 days up to p_asof, with five transparent, rule-based warning signs worked out
--   from what had been recorded by that day. No statistical model is hidden behind them.
--     silent           no payment for at least max(3 days, twice the plan's usual gap between
--                      payments) (10 days minimum for weekly plans)
--     slipping         the last 7 days covered at least 30 points less of the bill than the 7 days
--                      before, from a base of 40% or more
--     behind           at least 7 days behind on the first-in-first-out reading of the pinned bills
--                      (tops_shortfall_age_fallback)
--     moving_to_agent  the tenant paid 50%+ themselves in the earlier 14 days and 20% or less in the
--                      last 14, while still paying
--     refused_attempt  the tenant tried to pay themselves in the last 14 days and was refused because
--                      the paying number did not match, no phone was registered, or the wallet was empty
--   The score is how many of the five apply.
-- tops_payment_behaviour_watchlist(...)   the live list (as of the window's last day, capped at today),
--   the distribution by score and by sign, and a BACK-TEST: the same signs worked out as they stood
--   seven days earlier, compared with what actually happened in the seven days after. A plan "missed"
--   when it was billed in those seven days and covered less than half of that bill. The back-test is
--   an estimate of how useful the signs have been so far, with its sample sizes.

CREATE OR REPLACE FUNCTION public.tops_pay_behaviour_flags(
  p_asof date,
  p_agent_id uuid DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_cadence text DEFAULT NULL
)
RETURNS TABLE (
  fl_rr uuid,
  fl_tenant uuid,
  fl_agent uuid,
  fl_cadence text,
  fl_rent numeric,
  fl_bills7 numeric,
  fl_pay7 numeric,
  fl_bills_prev7 numeric,
  fl_pay_prev7 numeric,
  fl_last_paid_day date,
  fl_days_since int,
  fl_med_gap numeric,
  fl_behind_days int,
  fl_self28 numeric,
  fl_agent28 numeric,
  f_silent boolean,
  f_slipping boolean,
  f_behind boolean,
  f_to_agent boolean,
  f_refused boolean,
  fl_score int
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  RETURN QUERY
  WITH sc AS MATERIALIZED (
    SELECT * FROM public.tops_pay_behaviour_scope(p_agent_id, p_region, p_district, p_cadence)
    WHERE sc_status NOT IN ('completed', 'cancelled')
  ),
  bills AS (
    SELECT dp.rent_request_id AS rr_id,
           SUM(dp.expected_ugx) FILTER (WHERE dp.day BETWEEN p_asof - 6 AND p_asof) AS b7,
           SUM(dp.expected_ugx) FILTER (WHERE dp.day BETWEEN p_asof - 13 AND p_asof - 7) AS bp7,
           MIN(dp.day) FILTER (WHERE dp.expected_ugx > 0) AS first_bill
    FROM public.agent_expected_day_plans dp
    WHERE dp.day BETWEEN p_asof - 27 AND p_asof
      AND dp.rent_request_id IN (SELECT s0.sc_rr FROM sc s0)
    GROUP BY dp.rent_request_id
    HAVING COALESCE(SUM(dp.expected_ugx) FILTER (WHERE dp.day BETWEEN p_asof - 13 AND p_asof), 0) > 0
  ),
  pays AS MATERIALIZED (
    SELECT * FROM public.tops_pay_behaviour_payments(
      ((p_asof - 27)::timestamp AT TIME ZONE 'Africa/Kampala'), (p_asof::timestamp AT TIME ZONE 'Africa/Kampala'),
      p_agent_id, p_region, p_district, p_cadence)
  ),
  pay_agg AS (
    SELECT y.pay_rr AS rr_id,
           SUM(y.pay_amount) FILTER (WHERE y.pay_day BETWEEN p_asof - 6 AND p_asof) AS p7,
           SUM(y.pay_amount) FILTER (WHERE y.pay_day BETWEEN p_asof - 13 AND p_asof - 7) AS pp7,
           SUM(y.pay_amount) FILTER (WHERE y.pay_channel = 'self' AND y.pay_day BETWEEN p_asof - 13 AND p_asof) AS s14,
           SUM(y.pay_amount) FILTER (WHERE y.pay_day BETWEEN p_asof - 13 AND p_asof) AS a14,
           SUM(y.pay_amount) FILTER (WHERE y.pay_channel = 'self' AND y.pay_day BETWEEN p_asof - 27 AND p_asof - 14) AS sp14,
           SUM(y.pay_amount) FILTER (WHERE y.pay_day BETWEEN p_asof - 27 AND p_asof - 14) AS ap14,
           COALESCE(SUM(y.pay_amount) FILTER (WHERE y.pay_channel = 'self'), 0) AS self28,
           COALESCE(SUM(y.pay_amount) FILTER (WHERE y.pay_channel = 'agent'), 0) AS agent28,
           MAX(y.pay_day) AS last_paid
    FROM pays y GROUP BY y.pay_rr
  ),
  pay_days AS (
    SELECT DISTINCT y.pay_rr AS rr_id, y.pay_day AS d FROM pays y
  ),
  gaps AS (
    SELECT x.rr_id, (x.d - x.prev_d) AS gap
    FROM (SELECT pd.rr_id, pd.d, lag(pd.d) OVER (PARTITION BY pd.rr_id ORDER BY pd.d) AS prev_d FROM pay_days pd) x
    WHERE x.prev_d IS NOT NULL
  ),
  gap_med AS (
    SELECT g.rr_id, (percentile_cont(0.5) WITHIN GROUP (ORDER BY g.gap))::numeric AS med, count(*) AS n
    FROM gaps g GROUP BY g.rr_id
  ),
  behind AS (
    SELECT f.rent_request_id AS rr_id, f.days_behind AS d
    FROM public.tops_shortfall_age_fallback(p_asof) f
  ),
  refused AS (
    SELECT DISTINCT a.tenant_id AS tn
    FROM public.tenant_self_repayment_attempts a
    WHERE a.outcome = 'refused'
      AND a.reason IN ('payer_number_mismatch', 'no_registered_phone', 'no_withdrawable_balance')
      AND (a.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_asof - 13 AND p_asof
  ),
  base AS (
    SELECT s.sc_rr, s.sc_tenant, s.sc_agent, s.sc_cadence, s.sc_rent,
           COALESCE(b.b7, 0) AS b7, COALESCE(y.p7, 0) AS p7, COALESCE(b.bp7, 0) AS bp7, COALESCE(y.pp7, 0) AS pp7,
           y.last_paid, b.first_bill, gm.med, gm.n AS gn, bh.d AS behind_d,
           y.s14, y.a14, y.sp14, y.ap14, COALESCE(y.self28, 0) AS self28, COALESCE(y.agent28, 0) AS agent28,
           (r.tn IS NOT NULL) AS refused
    FROM sc s
    JOIN bills b ON b.rr_id = s.sc_rr
    LEFT JOIN pay_agg y ON y.rr_id = s.sc_rr
    LEFT JOIN gap_med gm ON gm.rr_id = s.sc_rr AND gm.n >= 2
    LEFT JOIN behind bh ON bh.rr_id = s.sc_rr
    LEFT JOIN refused r ON r.tn = s.sc_tenant
  ),
  calc AS (
    SELECT x.*,
           CASE WHEN x.last_paid IS NOT NULL THEN (p_asof - x.last_paid) ELSE (p_asof - x.first_bill + 1) END AS since
    FROM base x
  ),
  flagged AS (
    SELECT c.*,
      (c.since >= GREATEST(CASE WHEN c.sc_cadence = 'weekly' THEN 10 ELSE 3 END, ceil(2 * COALESCE(c.med, 1)))) AS f1,
      (c.b7 > 0 AND c.bp7 > 0 AND LEAST(c.pp7, c.bp7) / c.bp7 >= 0.4
         AND LEAST(c.p7, c.b7) / c.b7 <= LEAST(c.pp7, c.bp7) / c.bp7 - 0.3) AS f2,
      (COALESCE(c.behind_d, 0) >= 7) AS f3,
      (COALESCE(c.ap14, 0) > 0 AND COALESCE(c.sp14, 0) / c.ap14 >= 0.5
         AND COALESCE(c.a14, 0) > 0 AND COALESCE(c.s14, 0) / c.a14 <= 0.2) AS f4,
      c.refused AS f5
    FROM calc c
  )
  SELECT f.sc_rr, f.sc_tenant, f.sc_agent, f.sc_cadence, f.sc_rent, f.b7, f.p7, f.bp7, f.pp7, f.last_paid, f.since::int,
         round(f.med, 1), f.behind_d, f.self28, f.agent28, f.f1, f.f2, f.f3, f.f4, f.f5,
         (f.f1::int + f.f2::int + f.f3::int + f.f4::int + f.f5::int)
  FROM flagged f;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_pay_behaviour_flags(date, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_pay_behaviour_flags(date, uuid, text, text, text) TO authenticated;

-- ─── tops_payment_behaviour_watchlist ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tops_payment_behaviour_watchlist(
  p_start timestamptz,
  p_end timestamptz,
  p_agent_id uuid DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_cadence text DEFAULT NULL,
  p_min_score int DEFAULT 1,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
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
  ranked AS (
    SELECT l.*, row_number() OVER (ORDER BY l.fl_score DESC, COALESCE(l.fl_behind_days, 0) DESC, l.fl_days_since DESC, l.fl_rr) AS rn,
           count(*) OVER () AS n_total
    FROM live l WHERE l.fl_score >= v_min
  ),
  page AS (
    SELECT r.*, COALESCE(NULLIF(trim(tp.full_name), ''), 'Unnamed tenant') AS tn_name, tp.phone AS tn_phone,
           COALESCE(NULLIF(trim(ap.full_name), ''), 'Unnamed agent') AS ag_name, ap.phone AS ag_phone,
           tb.region AS rgn, tb.district_name AS dst
    FROM ranked r
    LEFT JOIN public.profiles tp ON tp.id = r.fl_tenant
    LEFT JOIN public.profiles ap ON ap.id = r.fl_agent
    LEFT JOIN public.v_tlb_tenant_base tb ON tb.tenant_id = r.fl_tenant
    WHERE r.rn > v_offset AND r.rn <= v_offset + v_limit
  ),
  -- back-test: signs as they stood at v_cut, outcome over v_cut+1 .. v_asof
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
          'refused_attempt', count(*) FILTER (WHERE l.f_refused)::int)
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
        'billed_7d_ugx', p.fl_bills7, 'paid_7d_ugx', p.fl_pay7, 'billed_prev_7d_ugx', p.fl_bills_prev7, 'paid_prev_7d_ugx', p.fl_pay_prev7,
        'self_paid_28d_ugx', p.fl_self28, 'agent_paid_28d_ugx', p.fl_agent28
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

REVOKE ALL ON FUNCTION public.tops_payment_behaviour_watchlist(timestamptz, timestamptz, uuid, text, text, text, int, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_payment_behaviour_watchlist(timestamptz, timestamptz, uuid, text, text, text, int, int, int) TO authenticated;

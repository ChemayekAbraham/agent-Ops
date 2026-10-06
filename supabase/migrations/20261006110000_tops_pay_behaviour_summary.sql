-- Tenant Payment Behavior: the headline summary and the full overview. Additive, read-only.
--
-- tops_payment_behaviour_summary  who paid (the tenant or an agent), how much, how many tenants,
--                                 and how well each group covers its bill. Same numbers feed the
--                                 Tenant Ops Home card and the top of the workspace tab.
-- tops_payment_behaviour_overview the summary plus behavioural segments, the shift between two
--                                 equal windows, a self-pay vs agent-only comparison with a
--                                 confidence interval, correlations, and the data limits.
--
-- Definitions (observed, not modelled):
--   paying tenant     a tenant with at least one valid payment in the window
--   self payer        a paying tenant with at least one self payment (collection_channel
--                     'tenant_deposit_auto'); equals the distinct tenants of settled
--                     tenant_self_repayment_attempts, the figure the weekly performance page uses
--   self only / agent only / mixed   what the tenant's payments in the window were made through
--   coverage          LEAST(paid, billed) / billed per Rent Plan over the window, the same capped
--                     basis tops_shortfall_lines uses; only plans billed in the window count
-- A window's "previous period" is the equal number of Kampala days immediately before it.
--
-- Estimates are returned in their own keys (comparison, correlations) and carry the sample sizes
-- they rest on, so the screen can say when there is not enough data.

CREATE OR REPLACE FUNCTION public.tops_payment_behaviour_summary(
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
  v_cur_pct numeric;
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
    SELECT * FROM public.tops_pay_behaviour_plans(p_start, p_end, p_agent_id, p_region, p_district, p_cadence)
  ),
  pay AS MATERIALIZED (
    SELECT * FROM public.tops_pay_behaviour_payments(p_start, p_end, p_agent_id, p_region, p_district, p_cadence)
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
           COALESCE(SUM(p.pay_amount), 0) AS ugx,
           round(AVG(p.pay_amount), 0) AS avg_ugx,
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY p.pay_amount))::numeric, 0) AS median_ugx,
           count(DISTINCT p.pay_tenant)::int AS tenants
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
  )
  SELECT jsonb_build_object(
    'window', jsonb_build_object('start_day', v_d1, 'end_day', v_d2, 'asof', v_asof, 'days', v_days),
    'data_since', jsonb_build_object(
      'first_self_payment_day', (SELECT (MIN(ac.created_at) AT TIME ZONE 'Africa/Kampala')::date FROM public.agent_collections ac WHERE ac.collection_channel = 'tenant_deposit_auto' AND ac.amount > 0 AND ac.reversed_at IS NULL),
      'first_billed_day', (SELECT MIN(dp.day) FROM public.agent_expected_day_plans dp)
    ),
    'basis', 'Self = collection_channel tenant_deposit_auto (tenant paid from their own number). Agent = agent_float (agent paid from their float). Reversed, zero and plan-less receipts excluded. Kampala days. Coverage = LEAST(paid, billed) / billed per Rent Plan.',
    'payments', jsonb_build_object(
      'self', (SELECT jsonb_build_object('n', c.n, 'ugx', c.ugx, 'avg_ugx', c.avg_ugx, 'median_ugx', c.median_ugx, 'tenants', c.tenants) FROM chan c WHERE c.ch = 'self'),
      'agent', (SELECT jsonb_build_object('n', c.n, 'ugx', c.ugx, 'avg_ugx', c.avg_ugx, 'median_ugx', c.median_ugx, 'tenants', c.tenants) FROM chan c WHERE c.ch = 'agent'),
      'other', (SELECT jsonb_build_object('n', c.n, 'ugx', c.ugx, 'avg_ugx', c.avg_ugx, 'median_ugx', c.median_ugx, 'tenants', c.tenants) FROM chan c WHERE c.ch = 'other'),
      'total_n', (SELECT SUM(c.n) FROM chan c),
      'total_ugx', (SELECT SUM(c.ugx) FROM chan c),
      'self_share_pct', (SELECT round(MAX(c.ugx) FILTER (WHERE c.ch = 'self') / NULLIF(SUM(c.ugx), 0) * 100, 1) FROM chan c),
      'agent_share_pct', (SELECT round(MAX(c.ugx) FILTER (WHERE c.ch = 'agent') / NULLIF(SUM(c.ugx), 0) * 100, 1) FROM chan c),
      'self_count_share_pct', (SELECT round(MAX(c.n) FILTER (WHERE c.ch = 'self')::numeric / NULLIF(SUM(c.n), 0) * 100, 1) FROM chan c)
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

REVOKE ALL ON FUNCTION public.tops_payment_behaviour_summary(timestamptz, timestamptz, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_payment_behaviour_summary(timestamptz, timestamptz, uuid, text, text, text) TO authenticated;

-- ─── tops_payment_behaviour_overview ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tops_payment_behaviour_overview(
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
  v_summary := public.tops_payment_behaviour_summary(p_start, p_end, p_agent_id, p_region, p_district, p_cadence);

  WITH pl AS MATERIALIZED (
    SELECT * FROM public.tops_pay_behaviour_plans(p_start, p_end, p_agent_id, p_region, p_district, p_cadence)
  ),
  prev AS MATERIALIZED (
    SELECT p.pay_tenant AS tn,
           COALESCE(SUM(p.pay_amount) FILTER (WHERE p.pay_channel = 'self'), 0) AS self_ugx,
           COALESCE(SUM(p.pay_amount) FILTER (WHERE p.pay_channel = 'agent'), 0) AS agent_ugx
    FROM public.tops_pay_behaviour_payments(v_prev_start, v_prev_end, p_agent_id, p_region, p_district, p_cadence) p
    GROUP BY p.pay_tenant
  ),
  t AS MATERIALIZED (
    SELECT l.pl_tenant AS tn,
           SUM(l.pl_billed_ugx) AS billed, SUM(l.pl_covered_ugx) AS covered,
           SUM(l.pl_self_ugx) AS self_ugx, SUM(l.pl_agent_ugx) AS agent_ugx,
           SUM(l.pl_self_n) AS self_n, SUM(l.pl_agent_n) AS agent_n,
           SUM(l.pl_billed_days) AS billed_days, SUM(l.pl_paid_days) AS paid_days,
           MAX(l.pl_rent) AS rent, MIN(l.pl_start) AS plan_start
    FROM pl l GROUP BY l.pl_tenant
  ),
  ts AS MATERIALIZED (
    SELECT t0.*,
           CASE WHEN t0.self_ugx + t0.agent_ugx > 0 THEN t0.self_ugx / (t0.self_ugx + t0.agent_ugx) END AS self_share,
           CASE WHEN t0.billed > 0 THEN t0.covered / t0.billed END AS cov,
           CASE WHEN t0.billed_days > 0 THEN LEAST(1.0, t0.paid_days::numeric / t0.billed_days) END AS day_ratio,
           pv.self_ugx AS p_self, pv.agent_ugx AS p_agent,
           CASE WHEN pv.self_ugx + pv.agent_ugx > 0 THEN pv.self_ugx / (pv.self_ugx + pv.agent_ugx) END AS p_share
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
        WHEN COALESCE(b.p_self, 0) = 0 AND b.p_agent > 0 AND b.self_ugx > 0 THEN 'new_self_adopter'
        WHEN COALESCE(b.p_self, 0) > 0 AND COALESCE(b.self_ugx, 0) = 0 AND b.agent_ugx > 0 THEN 'moving_to_agents'
      END AS shift
    FROM beh b WHERE b.p_self IS NOT NULL OR b.self_ugx > 0
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
      'definition', 'Share of the tenant''s paid amount that came from their own payments: self reliant 80%+, hybrid 20-80%, agent led with some self-pay under 20%, agent dependent 0%, no payment = billed but nothing paid.',
      'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'segment', g.bseg, 'tenants', g.tenants, 'billed_ugx', g.billed, 'covered_ugx', g.covered,
          'short_ugx', g.billed - g.covered, 'coverage_pct', round(g.covered / NULLIF(g.billed, 0) * 100, 1),
          'self_ugx', g.self_ugx, 'agent_ugx', g.agent_ugx, 'avg_paid_day_pct', g.avg_paid_day_pct)
          ORDER BY CASE g.bseg WHEN 'self_reliant' THEN 1 WHEN 'hybrid' THEN 2 WHEN 'agent_led_some_self' THEN 3 WHEN 'agent_dependent' THEN 4 ELSE 5 END)
          FROM beh_agg g), '[]'::jsonb)
    ),
    'shift', jsonb_build_object(
      'definition', 'Each tenant''s self-pay share of paid amount now versus the previous window of the same length. Moving to agents: was 50%+ self and fell by 30 points or more (or stopped self-paying). Moving to self: was 20% or less and rose by 30 points or more. New self adopter: paid only through agents before, now pays themselves.',
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

REVOKE ALL ON FUNCTION public.tops_payment_behaviour_overview(timestamptz, timestamptz, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_payment_behaviour_overview(timestamptz, timestamptz, uuid, text, text, text) TO authenticated;

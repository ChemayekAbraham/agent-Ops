-- Weekly Performance Management Summary needs a week-on-week delta for
-- "20+ Days No Payment" too (the PDF's exact Management Summary layout).
-- This is the same dormant-tenant definition already built in
-- get_tenant_ops_no_payment_report() (the "20+ Days No Payment" tab) -- reused
-- here as a plain count, not redesigned. Same live-plan/landlord-paid
-- eligibility gate, same last_pay_date source (v_rent_plan_schedule).
--
-- Note (same caveat already disclosed for total_active_tenants): this count
-- is "how many are dormant 20+ days right now", not "as of that historical
-- week's end" -- there is no point-in-time snapshot of dormancy to look back
-- on, so a frozen past week carries the count as of when it was frozen.

ALTER TABLE public.tenant_ops_weekly_metrics
  ADD COLUMN IF NOT EXISTS dormant_20_plus_count integer NOT NULL DEFAULT 0;

DROP FUNCTION IF EXISTS public._tenant_ops_weekly_metrics_raw(date, date);
CREATE OR REPLACE FUNCTION public._tenant_ops_weekly_metrics_raw(p_week_start date, p_week_end date)
RETURNS TABLE(
  total_active_tenants integer,
  paying_tenants integer,
  non_paying_tenants integer,
  new_tenants_added integer,
  payment_rate_pct numeric,
  self_payment_tenants integer,
  dormant_20_plus_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH active AS (
    SELECT tenant_id FROM public.v_tenant_ops_tenant_base WHERE is_active
  ),
  paid_this_week AS (
    SELECT DISTINCT x.tenant_id
      FROM (
        SELECT tenant_id, created_at FROM public.agent_collections WHERE tenant_id IS NOT NULL
        UNION ALL
        SELECT tenant_id, created_at FROM public.repayments WHERE tenant_id IS NOT NULL
      ) x
     WHERE (x.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_week_start AND p_week_end
  ),
  new_this_week AS (
    SELECT tenant_id FROM public.v_tenant_ops_tenant_base
     WHERE (tenant_created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_week_start AND p_week_end
  ),
  self_payers_this_week AS (
    SELECT DISTINCT tenant_id
      FROM public.tenant_self_repayment_attempts
     WHERE outcome = 'settled'
       AND (created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_week_start AND p_week_end
  ),
  watch AS (
    SELECT
      b.tenant_id,
      COALESCE(s.last_pay_date, b.funded_date) AS last_pay_date
    FROM public.v_tenant_ops_tenant_base b
    JOIN public.rent_requests rr ON rr.id = b.rent_request_id
    LEFT JOIN public.v_rent_plan_schedule s ON s.rent_request_id = b.rent_request_id
    WHERE b.is_active AND b.outstanding > 0
      AND (
        EXISTS (
          SELECT 1 FROM public.agent_landlord_float_allocations a
           WHERE a.rent_request_id = b.rent_request_id AND COALESCE(a.paid_out_amount, 0) > 0
        )
        OR EXISTS (
          SELECT 1 FROM public.landlord_payouts lp
           WHERE lp.rent_request_id = b.rent_request_id
             AND (lp.disbursed_at IS NOT NULL OR lp.finops_disbursed_at IS NOT NULL)
        )
      )
  ),
  dormant AS (
    SELECT w.tenant_id
      FROM watch w
     WHERE w.last_pay_date IS NOT NULL
       AND ((now() AT TIME ZONE 'Africa/Kampala')::date - w.last_pay_date) >= 20
  ),
  active_count AS (SELECT count(*)::int AS n FROM active),
  paying_count AS (
    SELECT count(*)::int AS n FROM active a
     WHERE EXISTS (SELECT 1 FROM paid_this_week p WHERE p.tenant_id = a.tenant_id)
  )
  SELECT
    (SELECT n FROM active_count),
    (SELECT n FROM paying_count),
    (SELECT n FROM active_count) - (SELECT n FROM paying_count),
    (SELECT count(*)::int FROM new_this_week),
    CASE WHEN (SELECT n FROM active_count) > 0
      THEN round((SELECT n FROM paying_count)::numeric / (SELECT n FROM active_count)::numeric * 100, 1)
      ELSE 0::numeric END,
    (SELECT count(*)::int FROM self_payers_this_week),
    (SELECT count(*)::int FROM dormant);
$$;

CREATE OR REPLACE FUNCTION public.pin_tenant_ops_weekly_metrics(p_anchor date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_anchor date := COALESCE(p_anchor, v_today - 7);
  v_start date;
  v_end date;
  v_row record;
  v_inserted integer := 0;
BEGIN
  SELECT period_start, period_end INTO v_start, v_end
    FROM public.tppo_period_bounds('week', v_anchor);

  IF v_end >= v_today THEN
    RETURN 0;
  END IF;

  SELECT * INTO v_row FROM public._tenant_ops_weekly_metrics_raw(v_start, v_end);

  INSERT INTO public.tenant_ops_weekly_metrics (
    week_start, week_end, total_active_tenants, paying_tenants,
    non_paying_tenants, new_tenants_added, payment_rate_pct, self_payment_tenants,
    dormant_20_plus_count
  ) VALUES (
    v_start, v_end, v_row.total_active_tenants, v_row.paying_tenants,
    v_row.non_paying_tenants, v_row.new_tenants_added, v_row.payment_rate_pct,
    v_row.self_payment_tenants, v_row.dormant_20_plus_count
  )
  ON CONFLICT (week_start) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_tenant_ops_weekly_performance(p_anchor date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_anchor date := COALESCE(p_anchor, v_today);
  v_cur_start date;
  v_cur_end date;
  v_prev_start date;
  v_prev_end date;
  v_cur record;
  v_prev record;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT period_start, period_end INTO v_cur_start, v_cur_end
    FROM public.tppo_period_bounds('week', v_anchor);
  v_prev_start := v_cur_start - 7;
  v_prev_end := v_cur_end - 7;

  IF v_cur_end < v_today THEN
    SELECT total_active_tenants, paying_tenants, non_paying_tenants, new_tenants_added,
           payment_rate_pct, self_payment_tenants, dormant_20_plus_count
      INTO v_cur
      FROM public.tenant_ops_weekly_metrics WHERE week_start = v_cur_start;
    IF NOT FOUND THEN
      SELECT * INTO v_cur FROM public._tenant_ops_weekly_metrics_raw(v_cur_start, v_cur_end);
    END IF;
  ELSE
    SELECT * INTO v_cur FROM public._tenant_ops_weekly_metrics_raw(v_cur_start, v_cur_end);
  END IF;

  SELECT total_active_tenants, paying_tenants, non_paying_tenants, new_tenants_added,
         payment_rate_pct, self_payment_tenants, dormant_20_plus_count
    INTO v_prev
    FROM public.tenant_ops_weekly_metrics WHERE week_start = v_prev_start;
  IF NOT FOUND THEN
    PERFORM public.pin_tenant_ops_weekly_metrics(v_prev_start);
    SELECT total_active_tenants, paying_tenants, non_paying_tenants, new_tenants_added,
           payment_rate_pct, self_payment_tenants, dormant_20_plus_count
      INTO v_prev
      FROM public.tenant_ops_weekly_metrics WHERE week_start = v_prev_start;
    IF NOT FOUND THEN
      SELECT * INTO v_prev FROM public._tenant_ops_weekly_metrics_raw(v_prev_start, v_prev_end);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'week_start', v_cur_start,
    'week_end', v_cur_end,
    'is_current_week_open', (v_cur_end >= v_today),
    'current', jsonb_build_object(
      'total_active_tenants', v_cur.total_active_tenants,
      'paying_tenants', v_cur.paying_tenants,
      'non_paying_tenants', v_cur.non_paying_tenants,
      'new_tenants_added', v_cur.new_tenants_added,
      'payment_rate_pct', v_cur.payment_rate_pct,
      'self_payment_tenants', v_cur.self_payment_tenants,
      'dormant_20_plus_count', v_cur.dormant_20_plus_count
    ),
    'previous', jsonb_build_object(
      'week_start', v_prev_start,
      'week_end', v_prev_end,
      'total_active_tenants', v_prev.total_active_tenants,
      'paying_tenants', v_prev.paying_tenants,
      'non_paying_tenants', v_prev.non_paying_tenants,
      'new_tenants_added', v_prev.new_tenants_added,
      'payment_rate_pct', v_prev.payment_rate_pct,
      'self_payment_tenants', v_prev.self_payment_tenants,
      'dormant_20_plus_count', v_prev.dormant_20_plus_count
    ),
    'delta', jsonb_build_object(
      'total_active_tenants', v_cur.total_active_tenants - v_prev.total_active_tenants,
      'paying_tenants', v_cur.paying_tenants - v_prev.paying_tenants,
      'non_paying_tenants', v_cur.non_paying_tenants - v_prev.non_paying_tenants,
      'new_tenants_added', v_cur.new_tenants_added - v_prev.new_tenants_added,
      'payment_rate_pct', round(v_cur.payment_rate_pct - v_prev.payment_rate_pct, 1),
      'self_payment_tenants', v_cur.self_payment_tenants - v_prev.self_payment_tenants,
      'self_payment_increase_pct', CASE
        WHEN v_prev.self_payment_tenants > 0
          THEN round((v_cur.self_payment_tenants - v_prev.self_payment_tenants)::numeric
                      / v_prev.self_payment_tenants::numeric * 100, 1)
        ELSE NULL
      END,
      'dormant_20_plus_count', v_cur.dormant_20_plus_count - v_prev.dormant_20_plus_count
    )
  );
END;
$$;

UPDATE public.tenant_ops_weekly_metrics m
   SET dormant_20_plus_count = (
     SELECT r.dormant_20_plus_count
       FROM public._tenant_ops_weekly_metrics_raw(m.week_start, m.week_end) r
   )
 WHERE m.dormant_20_plus_count = 0;

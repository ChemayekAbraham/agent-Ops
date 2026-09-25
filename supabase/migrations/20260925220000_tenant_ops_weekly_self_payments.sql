-- Tenant Ops "Tenant Self-Payments via Merchant" weekly tracking.
--
-- Reuses, does not reinvent:
--   * tenant_self_repayment_attempts / v_tenant_self_repayments (the existing,
--     already-CFO/Tenant-Ops/Agent-Ops-shared self-payment subsystem) --
--     outcome='settled' is the same success condition
--     get_tenant_self_repayments()'s own totals.settled_count already uses.
--   * The weekly snapshot table built for Prompt 1 (tenant_ops_weekly_metrics)
--     -- one more column, same freeze-once-closed mechanism, no separate
--     snapshot table for this one section.
--
-- get_tenant_self_repayments() itself only changes by ADDING
-- distinct_tenant_count to its existing totals object -- settled_count,
-- refused_count, total_applied, total_surplus and total_commission keep
-- their exact existing meaning and values.

CREATE OR REPLACE FUNCTION public.get_tenant_self_repayments(
  p_from timestamp with time zone DEFAULT (now() - '30 days'::interval),
  p_to timestamp with time zone DEFAULT now(),
  p_outcome text DEFAULT NULL::text,
  p_search text DEFAULT NULL::text,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb;
  v_total bigint;
  v_totals jsonb;
BEGIN
  IF NOT (
    public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'tenant_ops') OR public.has_role(v_uid, 'agent_ops')
    OR public.has_role(v_uid, 'coo') OR public.has_role(v_uid, 'ceo')
    OR public.has_role(v_uid, 'operations') OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  WITH base AS (
    SELECT * FROM public.tenant_self_repayment_attempts a
     WHERE a.created_at >= p_from AND a.created_at <= p_to
       AND (p_outcome IS NULL OR a.outcome = p_outcome)
  ), joined AS (
    SELECT v.* FROM public.v_tenant_self_repayments v
     JOIN base b ON b.id = v.attempt_id
     WHERE p_search IS NULL OR p_search = ''
       OR v.tenant_name ILIKE '%' || p_search || '%'
       OR v.agent_name ILIKE '%' || p_search || '%'
       OR v.paid_from_phone ILIKE '%' || p_search || '%'
       OR COALESCE(v.external_reference, '') ILIKE '%' || p_search || '%'
       OR COALESCE(v.tracking_id, '') ILIKE '%' || p_search || '%'
  )
  SELECT
    COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.paid_at DESC), '[]'::jsonb),
    (SELECT count(*) FROM joined),
    (SELECT jsonb_build_object(
        'settled_count', count(*) FILTER (WHERE outcome = 'settled'),
        'refused_count', count(*) FILTER (WHERE outcome <> 'settled'),
        'total_applied', COALESCE(sum(applied_amount), 0),
        'total_surplus', COALESCE(sum(float_kept), 0),
        'total_commission', COALESCE(sum(commission_total), 0),
        'distinct_tenant_count', count(DISTINCT tenant_id) FILTER (WHERE outcome = 'settled')
      ) FROM joined)
  INTO v_rows, v_total, v_totals
  FROM (
    SELECT * FROM joined ORDER BY paid_at DESC LIMIT GREATEST(1, LEAST(p_limit, 500)) OFFSET GREATEST(0, p_offset)
  ) t;

  RETURN jsonb_build_object('rows', v_rows, 'total', v_total, 'totals', v_totals);
END;
$$;

-- Weekly snapshot: one more frozen figure per week.
ALTER TABLE public.tenant_ops_weekly_metrics
  ADD COLUMN IF NOT EXISTS self_payment_tenants integer NOT NULL DEFAULT 0;

DROP FUNCTION IF EXISTS public._tenant_ops_weekly_metrics_raw(date, date);
CREATE OR REPLACE FUNCTION public._tenant_ops_weekly_metrics_raw(p_week_start date, p_week_end date)
RETURNS TABLE(
  total_active_tenants integer,
  paying_tenants integer,
  non_paying_tenants integer,
  new_tenants_added integer,
  payment_rate_pct numeric,
  self_payment_tenants integer
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
    (SELECT count(*)::int FROM self_payers_this_week);
$$;

-- pin_tenant_ops_weekly_metrics() now also freezes self_payment_tenants.
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
    non_paying_tenants, new_tenants_added, payment_rate_pct, self_payment_tenants
  ) VALUES (
    v_start, v_end, v_row.total_active_tenants, v_row.paying_tenants,
    v_row.non_paying_tenants, v_row.new_tenants_added, v_row.payment_rate_pct,
    v_row.self_payment_tenants
  )
  ON CONFLICT (week_start) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

-- Main read: current/previous/delta now also carry self_payment_tenants.
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
           payment_rate_pct, self_payment_tenants
      INTO v_cur
      FROM public.tenant_ops_weekly_metrics WHERE week_start = v_cur_start;
    IF NOT FOUND THEN
      SELECT * INTO v_cur FROM public._tenant_ops_weekly_metrics_raw(v_cur_start, v_cur_end);
    END IF;
  ELSE
    SELECT * INTO v_cur FROM public._tenant_ops_weekly_metrics_raw(v_cur_start, v_cur_end);
  END IF;

  SELECT total_active_tenants, paying_tenants, non_paying_tenants, new_tenants_added,
         payment_rate_pct, self_payment_tenants
    INTO v_prev
    FROM public.tenant_ops_weekly_metrics WHERE week_start = v_prev_start;
  IF NOT FOUND THEN
    PERFORM public.pin_tenant_ops_weekly_metrics(v_prev_start);
    SELECT total_active_tenants, paying_tenants, non_paying_tenants, new_tenants_added,
           payment_rate_pct, self_payment_tenants
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
      'self_payment_tenants', v_cur.self_payment_tenants
    ),
    'previous', jsonb_build_object(
      'week_start', v_prev_start,
      'week_end', v_prev_end,
      'total_active_tenants', v_prev.total_active_tenants,
      'paying_tenants', v_prev.paying_tenants,
      'non_paying_tenants', v_prev.non_paying_tenants,
      'new_tenants_added', v_prev.new_tenants_added,
      'payment_rate_pct', v_prev.payment_rate_pct,
      'self_payment_tenants', v_prev.self_payment_tenants
    ),
    'delta', jsonb_build_object(
      'total_active_tenants', v_cur.total_active_tenants - v_prev.total_active_tenants,
      'paying_tenants', v_cur.paying_tenants - v_prev.paying_tenants,
      'non_paying_tenants', v_cur.non_paying_tenants - v_prev.non_paying_tenants,
      'new_tenants_added', v_cur.new_tenants_added - v_prev.new_tenants_added,
      'payment_rate_pct', round(v_cur.payment_rate_pct - v_prev.payment_rate_pct, 1),
      'self_payment_tenants', v_cur.self_payment_tenants - v_prev.self_payment_tenants,
      -- Week-on-week increase rate, guarding the division so a zero prior
      -- week never throws -- null (not 0) when there is nothing to compare
      -- against, so the UI can show "New" instead of a misleading 0%.
      'self_payment_increase_pct', CASE
        WHEN v_prev.self_payment_tenants > 0
          THEN round((v_cur.self_payment_tenants - v_prev.self_payment_tenants)::numeric
                      / v_prev.self_payment_tenants::numeric * 100, 1)
        ELSE NULL
      END
    )
  );
END;
$$;

-- One-time backfill: the 8 weeks already frozen under Prompt 1 got
-- self_payment_tenants=0 from the column default. This fills in the real
-- figure for those already-closed weeks without touching any of their other
-- (already-correct, already-frozen) numbers.
UPDATE public.tenant_ops_weekly_metrics m
   SET self_payment_tenants = (
     SELECT r.self_payment_tenants
       FROM public._tenant_ops_weekly_metrics_raw(m.week_start, m.week_end) r
   )
 WHERE m.self_payment_tenants = 0;

DROP FUNCTION IF EXISTS public.get_agent_ops_rent_behaviour(integer, integer);

CREATE OR REPLACE FUNCTION public.get_agent_ops_rent_behaviour(
  p_limit integer DEFAULT 15,
  p_offset integer DEFAULT 0,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_sort text DEFAULT 'recent'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 15), 1), 50);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_to date := LEAST(COALESCE(p_to, v_today), v_today);
  v_from date := COALESCE(p_from, LEAST(COALESCE(p_to, v_today), v_today) - 29);
  v_days integer;
  v_sort text := COALESCE(NULLIF(p_sort, ''), 'recent');
  v_result jsonb;
BEGIN
  IF v_actor IS NULL OR NOT public.agent_ops_can_view_rent_behaviour(v_actor) THEN
    RAISE EXCEPTION 'Not authorised to view rent behaviour';
  END IF;

  IF v_from > v_to THEN
    v_from := v_to;
  END IF;
  v_days := (v_to - v_from) + 1;

  WITH active_requests AS (
    SELECT rr.*
    FROM public.rent_requests rr
    WHERE rr.tenant_id IS NOT NULL
      AND rr.agent_id IS NOT NULL
      AND rr.status IN ('repaying', 'funded')
  ), pairs AS (
    SELECT DISTINCT ar.tenant_id, ar.agent_id
    FROM active_requests ar
  ), collections AS (
    SELECT
      ac.tenant_id,
      ac.agent_id,
      COUNT(*)::integer AS collection_count,
      COALESCE(SUM(ac.amount), 0)::numeric AS amount_collected,
      MAX(ac.created_at) AS last_collection_at,
      (ARRAY_AGG(ac.amount ORDER BY ac.created_at DESC))[1]::numeric AS last_collection_amount,
      (ARRAY_AGG(ac.payment_method::text ORDER BY ac.created_at DESC))[1]::text AS last_payment_method,
      COALESCE(SUM(ac.amount) FILTER (WHERE ac.local_day = v_today), 0)::numeric AS paid_today,
      COALESCE(SUM(ac.amount) FILTER (WHERE ac.local_day BETWEEN v_from AND v_to), 0)::numeric AS paid_in_period,
      COUNT(*) FILTER (WHERE ac.local_day BETWEEN v_from AND v_to)::integer AS period_collection_count,
      COUNT(DISTINCT ac.local_day) FILTER (WHERE ac.local_day BETWEEN v_from AND v_to)::integer AS paid_days,
      COUNT(*) FILTER (
        WHERE prev_created_at IS NULL OR ac.created_at <= prev_created_at + interval '2 days'
      )::integer AS on_time_count,
      COUNT(*) FILTER (WHERE prev_created_at IS NOT NULL)::integer AS gap_checked_count,
      AVG(EXTRACT(EPOCH FROM (ac.created_at - prev_created_at)) / 3600.0) FILTER (WHERE prev_created_at IS NOT NULL)::numeric AS avg_gap_hours,
      AVG(EXTRACT(HOUR FROM (ac.created_at AT TIME ZONE 'Africa/Kampala')) )::numeric AS avg_payment_hour
    FROM (
      SELECT ac.*,
        (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS local_day,
        LAG(ac.created_at) OVER (PARTITION BY ac.tenant_id, ac.agent_id ORDER BY ac.created_at) AS prev_created_at
      FROM public.agent_collections ac
      JOIN pairs p ON p.tenant_id = ac.tenant_id AND p.agent_id = ac.agent_id
      WHERE ac.tenant_id IS NOT NULL
        AND ac.agent_id IS NOT NULL
    ) ac
    GROUP BY ac.tenant_id, ac.agent_id
  ), requests AS (
    SELECT
      ar.tenant_id,
      ar.agent_id,
      COUNT(*)::integer AS rent_request_count,
      COALESCE(SUM(ar.total_repayment), 0)::numeric AS total_to_collect,
      COALESCE(SUM(ar.amount_repaid), 0)::numeric AS total_repaid,
      COALESCE(SUM(GREATEST(COALESCE(ar.total_repayment, 0) - COALESCE(ar.amount_repaid, 0), 0)), 0)::numeric AS remaining_balance,
      COALESCE(SUM(ar.daily_repayment), 0)::numeric AS daily_expected,
      MIN(NULLIF(ar.number_of_payments, 0))::integer AS min_number_of_payments,
      MAX(ar.created_at) AS last_request_at
    FROM active_requests ar
    GROUP BY ar.tenant_id, ar.agent_id
  ), commissions AS (
    SELECT
      cal.tenant_id,
      cal.agent_id,
      COALESCE(SUM(cal.amount), 0)::numeric AS agent_commission_total
    FROM public.commission_accrual_ledger cal
    JOIN pairs p ON p.tenant_id = cal.tenant_id AND p.agent_id = cal.agent_id
    WHERE cal.tenant_id IS NOT NULL
      AND cal.agent_id IS NOT NULL
    GROUP BY cal.tenant_id, cal.agent_id
  ), rows_base AS (
    SELECT
      p.tenant_id,
      p.agent_id,
      COALESCE(tp.full_name, 'Unnamed tenant') AS tenant_name,
      tp.avatar_url AS tenant_avatar_url,
      tp.phone AS tenant_phone,
      tp.email AS tenant_email,
      tp.created_at AS tenant_created_at,
      COALESCE(ap.full_name, 'Unnamed agent') AS agent_name,
      ap.avatar_url AS agent_avatar_url,
      ap.phone AS agent_phone,
      ap.email AS agent_email,
      c.last_collection_at,
      COALESCE(c.last_collection_amount, 0)::numeric AS last_collection_amount,
      COALESCE(c.amount_collected, 0)::numeric AS amount_collected,
      COALESCE(c.paid_today, 0)::numeric AS paid_today,
      COALESCE(c.paid_in_period, 0)::numeric AS paid_in_period,
      COALESCE(c.period_collection_count, 0)::integer AS period_collection_count,
      COALESCE(r.daily_expected, 0)::numeric AS expected_today,
      (COALESCE(r.daily_expected, 0) * v_days)::numeric AS expected_in_period,
      (CASE
        WHEN COALESCE(r.daily_expected, 0) <= 0 THEN 0
        ELSE GREATEST(v_days - COALESCE(c.paid_days, 0), 0)
      END)::integer AS missed_days,
      COALESCE(c.paid_days, 0)::integer AS paid_days,
      COALESCE(r.remaining_balance, 0)::numeric AS remaining_balance,
      COALESCE(r.total_to_collect, 0)::numeric AS total_to_collect,
      COALESCE(r.total_repaid, 0)::numeric AS total_repaid,
      COALESCE(r.daily_expected, 0)::numeric AS daily_expected,
      COALESCE(c.collection_count, 0)::integer AS collection_count,
      COALESCE(r.rent_request_count, 0)::integer AS rent_request_count,
      COALESCE(cm.agent_commission_total, 0)::numeric AS agent_commission_total,
      COALESCE(c.on_time_count, 0)::integer AS on_time_count,
      COALESCE(c.gap_checked_count, 0)::integer AS gap_checked_count,
      CASE
        WHEN COALESCE(c.collection_count, 0) >= 4 AND COALESCE(c.avg_gap_hours, 0) <= 72 THEN 'Daily'
        WHEN COALESCE(c.collection_count, 0) >= 2 AND COALESCE(c.avg_gap_hours, 0) <= 240 THEN 'Weekly'
        WHEN COALESCE(c.collection_count, 0) > 0 THEN 'Monthly'
        WHEN COALESCE(r.min_number_of_payments, 0) >= 20 THEN 'Daily'
        WHEN COALESCE(r.min_number_of_payments, 0) BETWEEN 4 AND 8 THEN 'Weekly'
        ELSE 'Monthly'
      END AS collection_mode,
      CASE
        WHEN COALESCE(c.gap_checked_count, 0) = 0 THEN true
        ELSE COALESCE(c.on_time_count, 0)::numeric / NULLIF(c.gap_checked_count, 0) >= 0.8
      END AS pays_in_time,
      CASE
        WHEN COALESCE(c.gap_checked_count, 0) = 0 THEN 100
        ELSE ROUND((COALESCE(c.on_time_count, 0)::numeric / NULLIF(c.gap_checked_count, 0)) * 100, 1)
      END AS on_time_rate,
      COALESCE(c.avg_gap_hours, 0)::numeric AS avg_gap_hours,
      COALESCE(c.avg_payment_hour, 0)::numeric AS avg_payment_hour,
      COALESCE(c.last_payment_method, 'unknown') AS last_payment_method,
      COALESCE(c.last_collection_at, r.last_request_at, tp.created_at) AS sort_at
    FROM pairs p
    LEFT JOIN collections c ON c.tenant_id = p.tenant_id AND c.agent_id = p.agent_id
    LEFT JOIN requests r ON r.tenant_id = p.tenant_id AND r.agent_id = p.agent_id
    LEFT JOIN commissions cm ON cm.tenant_id = p.tenant_id AND cm.agent_id = p.agent_id
    LEFT JOIN public.profiles tp ON tp.id = p.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = p.agent_id
  ), numbered AS (
    SELECT rb.*, COUNT(*) OVER ()::integer AS total_count
    FROM rows_base rb
    ORDER BY
      CASE WHEN v_sort = 'missed' THEN rb.missed_days END DESC NULLS LAST,
      CASE WHEN v_sort = 'paid_today' THEN rb.paid_today END DESC NULLS LAST,
      CASE WHEN v_sort = 'remaining' THEN rb.remaining_balance END DESC NULLS LAST,
      rb.sort_at DESC NULLS LAST,
      rb.tenant_name ASC
  ), page_rows AS (
    SELECT *
    FROM numbered
    OFFSET v_offset
    LIMIT v_limit
  ), kpis AS (
    SELECT
      COUNT(*)::integer AS tenants_tracked,
      COALESCE(SUM(amount_collected), 0)::numeric AS total_collected,
      COALESCE(SUM(remaining_balance), 0)::numeric AS remaining_balance,
      COALESCE(SUM(collection_count), 0)::integer AS collection_count,
      COALESCE(SUM(paid_today), 0)::numeric AS paid_today,
      COALESCE(SUM(paid_in_period), 0)::numeric AS paid_in_period,
      COALESCE(SUM(expected_today), 0)::numeric AS expected_today,
      COALESCE(SUM(expected_in_period), 0)::numeric AS expected_in_period,
      COALESCE(SUM(missed_days), 0)::integer AS missed_days,
      CASE
        WHEN COALESCE(SUM(gap_checked_count), 0) = 0 THEN 100
        ELSE ROUND((COALESCE(SUM(on_time_count), 0)::numeric / NULLIF(SUM(gap_checked_count), 0)) * 100, 1)
      END AS on_time_rate
    FROM rows_base
  )
  SELECT jsonb_build_object(
    'limit', v_limit,
    'offset', v_offset,
    'from', v_from,
    'to', v_to,
    'days', v_days,
    'sort', v_sort,
    'total', COALESCE((SELECT MAX(total_count) FROM numbered), 0),
    'kpis', jsonb_build_object(
      'tenants_tracked', COALESCE((SELECT tenants_tracked FROM kpis), 0),
      'total_collected', COALESCE((SELECT total_collected FROM kpis), 0),
      'on_time_rate', COALESCE((SELECT on_time_rate FROM kpis), 0),
      'remaining_balance', COALESCE((SELECT remaining_balance FROM kpis), 0),
      'collection_count', COALESCE((SELECT collection_count FROM kpis), 0),
      'paid_today', COALESCE((SELECT paid_today FROM kpis), 0),
      'paid_in_period', COALESCE((SELECT paid_in_period FROM kpis), 0),
      'expected_today', COALESCE((SELECT expected_today FROM kpis), 0),
      'expected_in_period', COALESCE((SELECT expected_in_period FROM kpis), 0),
      'missed_days', COALESCE((SELECT missed_days FROM kpis), 0)
    ),
    'rows', COALESCE((
      SELECT jsonb_agg(to_jsonb(pr) - 'total_count' - 'sort_at')
      FROM page_rows pr
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_ops_rent_behaviour(integer, integer, date, date, text) TO authenticated;
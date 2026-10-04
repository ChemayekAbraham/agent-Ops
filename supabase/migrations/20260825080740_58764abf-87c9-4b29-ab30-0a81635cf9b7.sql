CREATE OR REPLACE FUNCTION public.get_agent_guarantor_float_preview(
  p_baseline_date date DEFAULT date '2026-08-24',
  p_as_of date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_of date := COALESCE(p_as_of, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_result jsonb;
BEGIN
  IF NOT (
    has_role(auth.uid(), 'agent_ops') OR has_role(auth.uid(), 'manager')
    OR has_role(auth.uid(), 'coo') OR has_role(auth.uid(), 'ceo')
    OR has_role(auth.uid(), 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  WITH elig AS (
    SELECT e.rent_request_id, e.tenant_id, e.agent_id, e.daily_repayment,
           GREATEST(e.total_repayment - e.amount_repaid, 0) AS outstanding
    FROM v_tenant_daily_eligibility e
    WHERE e.agent_id IS NOT NULL AND e.daily_repayment > 0
  ),
  col AS (
    SELECT ac.rent_request_id, ac.created_at
    FROM agent_collections ac
    JOIN elig ON elig.rent_request_id = ac.rent_request_id
  ),
  col_stats AS (
    SELECT rent_request_id,
           COUNT(*)::int AS pay_count,
           MAX(created_at) AS last_collection_at
    FROM col GROUP BY rent_request_id
  ),
  gaps AS (
    SELECT rent_request_id,
           EXTRACT(EPOCH FROM (created_at - LAG(created_at) OVER (PARTITION BY rent_request_id ORDER BY created_at))) / 86400.0 AS gap_days
    FROM col
  ),
  med AS (
    SELECT rent_request_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_days) AS median_gap
    FROM gaps WHERE gap_days IS NOT NULL GROUP BY rent_request_id
  ),
  classified AS (
    SELECT e.*,
           cs.pay_count,
           cs.last_collection_at,
           CASE
             WHEN COALESCE(cs.pay_count, 0) < 2 THEN 'unknown'
             WHEN m.median_gap <= 2 THEN 'daily'
             WHEN cs.pay_count >= 3 AND m.median_gap BETWEEN 5 AND 9 THEN 'weekly'
             WHEN cs.pay_count >= 3 AND m.median_gap BETWEEN 12 AND 17 THEN 'fortnightly'
             ELSE 'irregular'
           END AS cadence
    FROM elig e
    LEFT JOIN col_stats cs ON cs.rent_request_id = e.rent_request_id
    LEFT JOIN med m ON m.rent_request_id = e.rent_request_id
  ),
  thresholded AS (
    SELECT c.*,
           CASE c.cadence WHEN 'weekly' THEN 9 WHEN 'fortnightly' THEN 17 ELSE 2 END AS flag_threshold,
           CASE c.cadence WHEN 'weekly' THEN 16 WHEN 'fortnightly' THEN 31 ELSE 8 END AS advance_threshold,
           GREATEST(
             p_baseline_date,
             COALESCE((c.last_collection_at AT TIME ZONE 'Africa/Kampala')::date + 1, p_baseline_date)
           ) AS quiet_start
    FROM classified c
  ),
  quiet AS (
    SELECT t.*,
           GREATEST((v_as_of - t.quiet_start), 0) AS days_quiet
    FROM thresholded t
  ),
  shortfalls AS (
    SELECT q.*,
           LEAST(q.daily_repayment * LEAST(q.days_quiet, q.advance_threshold), q.outstanding) AS missing_amount,
           (q.days_quiet >= q.advance_threshold) AS advance_ready
    FROM quiet q
    WHERE q.days_quiet >= q.flag_threshold
  ),
  agent_float AS (
    SELECT w.user_id AS agent_id, GREATEST(COALESCE(w.float_balance, 0), 0) AS float_available
    FROM wallets w
    WHERE w.user_id IN (SELECT DISTINCT agent_id FROM shortfalls)
  ),
  allocated AS (
    SELECT s.*,
           COALESCE(af.float_available, 0) AS float_available,
           CASE WHEN s.advance_ready THEN
             LEAST(
               s.missing_amount,
               GREATEST(
                 COALESCE(af.float_available, 0) - COALESCE(SUM(s.missing_amount) FILTER (WHERE s.advance_ready)
                   OVER (PARTITION BY s.agent_id ORDER BY s.quiet_start, s.outstanding DESC, s.rent_request_id
                         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0),
                 0)
             )
           ELSE 0 END AS float_allocation
    FROM shortfalls s
    LEFT JOIN agent_float af ON af.agent_id = s.agent_id
  ),
  rows_out AS (
    SELECT a.*,
           p.full_name AS tenant_name,
           CASE WHEN a.advance_ready THEN GREATEST(a.missing_amount - a.float_allocation, 0) ELSE 0 END AS residual_advance
    FROM allocated a
    LEFT JOIN profiles p ON p.id = a.tenant_id
  ),
  agents_out AS (
    SELECT r.agent_id,
           ap.full_name AS agent_name,
           ap.phone AS agent_phone,
           MAX(r.float_available) AS float_available,
           SUM(r.missing_amount) AS total_shortfall,
           SUM(r.float_allocation) AS amount_to_deduct,
           GREATEST(MAX(r.float_available) - SUM(r.float_allocation), 0) AS float_remaining,
           SUM(r.residual_advance) AS residual_advance,
           COUNT(*)::int AS tenant_count,
           COUNT(*) FILTER (WHERE r.advance_ready)::int AS advance_ready_count,
           jsonb_agg(
             jsonb_build_object(
               'rent_request_id', r.rent_request_id,
               'tenant_id', r.tenant_id,
               'tenant_name', r.tenant_name,
               'cadence', r.cadence,
               'pay_count', COALESCE(r.pay_count, 0),
               'last_collection_at', r.last_collection_at,
               'quiet_start', r.quiet_start,
               'days_quiet', r.days_quiet,
               'flag_threshold', r.flag_threshold,
               'advance_threshold', r.advance_threshold,
               'daily_repayment', r.daily_repayment,
               'outstanding', r.outstanding,
               'missing_amount', r.missing_amount,
               'float_allocation', r.float_allocation,
               'residual_advance', r.residual_advance,
               'state', CASE WHEN r.advance_ready THEN 'advance_ready' ELSE 'flagged' END
             )
             ORDER BY r.days_quiet DESC, r.missing_amount DESC
           ) AS tenants
    FROM rows_out r
    LEFT JOIN profiles ap ON ap.id = r.agent_id
    GROUP BY r.agent_id, ap.full_name, ap.phone
  )
  SELECT jsonb_build_object(
    'baseline_date', p_baseline_date,
    'as_of', v_as_of,
    'agents', COALESCE((
      SELECT jsonb_agg(to_jsonb(a) ORDER BY a.amount_to_deduct DESC, a.total_shortfall DESC)
      FROM agents_out a
    ), '[]'::jsonb),
    'totals', COALESCE((
      SELECT jsonb_build_object(
        'agents', COUNT(*)::int,
        'tenants', COALESCE(SUM(a.tenant_count), 0)::int,
        'advance_ready_tenants', COALESCE(SUM(a.advance_ready_count), 0)::int,
        'total_shortfall', COALESCE(SUM(a.total_shortfall), 0),
        'float_available', COALESCE(SUM(a.float_available), 0),
        'amount_to_deduct', COALESCE(SUM(a.amount_to_deduct), 0),
        'float_remaining', COALESCE(SUM(a.float_remaining), 0),
        'residual_advance', COALESCE(SUM(a.residual_advance), 0)
      ) FROM agents_out a
    ), jsonb_build_object('agents', 0, 'tenants', 0, 'advance_ready_tenants', 0,
                          'total_shortfall', 0, 'float_available', 0,
                          'amount_to_deduct', 0, 'float_remaining', 0, 'residual_advance', 0))
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_agent_guarantor_float_preview(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agent_guarantor_float_preview(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_guarantor_float_preview(date, date) TO service_role;
CREATE OR REPLACE FUNCTION public.ops_tenant_ops_weekly_bundle(
  p_from timestamptz,
  p_to timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_days jsonb;
  v_window jsonb;
  v_missed jsonb;
  v_capacity jsonb;
  v_pipeline jsonb;
BEGIN
  WITH days AS (
    SELECT generate_series(
      (p_from AT TIME ZONE 'Africa/Kampala')::date,
      (p_to   AT TIME ZONE 'Africa/Kampala')::date,
      interval '1 day')::date AS d
  ), applied AS (
    SELECT (rr.created_at AT TIME ZONE 'Africa/Kampala')::date AS d, count(*) n
    FROM rent_requests rr
    WHERE rr.created_at >= p_from AND rr.created_at <= p_to
    GROUP BY 1
  ), approved AS (
    SELECT (rr.tenant_ops_reviewed_at AT TIME ZONE 'Africa/Kampala')::date AS d, count(*) n
    FROM rent_requests rr
    WHERE rr.tenant_ops_reviewed_at >= p_from AND rr.tenant_ops_reviewed_at <= p_to
    GROUP BY 1
  ), funded AS (
    SELECT (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date AS d,
           count(*) n, COALESCE(sum(rr.rent_amount),0) amt
    FROM rent_requests rr
    WHERE rr.funded_at >= p_from AND rr.funded_at <= p_to
    GROUP BY 1
  ), collected AS (
    SELECT (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS d,
           count(*) n, COALESCE(sum(ac.amount),0) amt
    FROM agent_collections ac
    WHERE ac.created_at >= p_from AND ac.created_at <= p_to
    GROUP BY 1
  ), expected AS (
    SELECT d.d,
           COALESCE(sum(rr.daily_repayment),0) AS expected_daily,
           count(rr.id) AS active_plans
    FROM days d
    LEFT JOIN rent_requests rr
      ON rr.status IN ('funded','disbursed','repaying')
     AND (COALESCE(rr.disbursed_at, rr.funded_at, rr.created_at) AT TIME ZONE 'Africa/Kampala')::date <= d.d
    GROUP BY d.d
  )
  SELECT jsonb_agg(jsonb_build_object(
           'day', d.d,
           'applied', COALESCE(a.n,0),
           'tops_approved', COALESCE(ap.n,0),
           'funded_plans', COALESCE(f.n,0),
           'funded_amount', COALESCE(f.amt,0),
           'collected', COALESCE(c.amt,0),
           'txns', COALESCE(c.n,0),
           'expected_daily', e.expected_daily,
           'active_plans', e.active_plans
         ) ORDER BY d.d)
  INTO v_days
  FROM days d
  LEFT JOIN applied a ON a.d = d.d
  LEFT JOIN approved ap ON ap.d = d.d
  LEFT JOIN funded f ON f.d = d.d
  LEFT JOIN collected c ON c.d = d.d
  LEFT JOIN expected e ON e.d = d.d;

  SELECT jsonb_build_object(
    'applied', (SELECT count(*) FROM rent_requests WHERE created_at BETWEEN p_from AND p_to),
    'tops_approved', (SELECT count(*) FROM rent_requests WHERE tenant_ops_reviewed_at BETWEEN p_from AND p_to),
    'funded_plans', (SELECT count(*) FROM rent_requests WHERE funded_at BETWEEN p_from AND p_to),
    'funded_amount', (SELECT COALESCE(sum(rent_amount),0) FROM rent_requests WHERE funded_at BETWEEN p_from AND p_to),
    'collected', (SELECT COALESCE(sum(amount),0) FROM agent_collections WHERE created_at BETWEEN p_from AND p_to),
    'txns', (SELECT count(*) FROM agent_collections WHERE created_at BETWEEN p_from AND p_to),
    'tenants_paid', (SELECT count(DISTINCT tenant_id) FROM agent_collections WHERE created_at BETWEEN p_from AND p_to)
  ) INTO v_window;

  WITH calc AS (
    SELECT rr.id, rr.agent_id,
           COALESCE(rr.daily_repayment,0) dr,
           COALESCE(rr.total_repayment,0) tr,
           COALESCE(rr.amount_repaid,0) ar,
           GREATEST(1, (date_part('day', now() - COALESCE(rr.disbursed_at, rr.funded_at, rr.created_at)))::int) ds
    FROM rent_requests rr
    WHERE rr.status IN ('funded','disbursed','repaying')
  ), e AS (
    SELECT c.*,
           GREATEST(0, round((LEAST(c.dr * c.ds, c.tr) - c.ar) / NULLIF(c.dr,0)))::int md
    FROM calc c
  )
  SELECT jsonb_build_object(
    'active_plans', count(*),
    'critical', count(*) FILTER (WHERE md >= 5),
    'warning', count(*) FILTER (WHERE md BETWEEN 2 AND 4),
    'on_track', count(*) FILTER (WHERE md < 2),
    'missed_days_total', COALESCE(sum(md),0)
  ) INTO v_missed FROM e;

  SELECT jsonb_build_object(
    'lifecycle', (
      SELECT jsonb_agg(jsonb_build_object('status', s.status, 'n', s.n, 'amount', s.amt) ORDER BY s.n DESC)
      FROM (
        SELECT status, count(*) n, COALESCE(sum(rent_amount),0) amt
        FROM rent_requests GROUP BY status
      ) s
    ),
    'receivables', (
      SELECT COALESCE(sum(GREATEST(0, COALESCE(total_repayment,0) - COALESCE(amount_repaid,0))),0)
      FROM rent_requests WHERE status IN ('funded','disbursed','repaying')
    ),
    'landlord_payables', (
      SELECT COALESCE(sum(COALESCE(rent_amount,0)),0)
      FROM rent_requests
      WHERE status IN ('funded','disbursed') AND payout_transaction_reference IS NULL
    )
  ) INTO v_pipeline;

  WITH cap AS (
    SELECT rr.agent_id,
           count(*) FILTER (WHERE rr.status IN ('funded','disbursed','repaying')) active_plans,
           COALESCE(sum(rr.daily_repayment) FILTER (WHERE rr.status IN ('funded','disbursed','repaying')),0) expected_daily
    FROM rent_requests rr
    GROUP BY rr.agent_id
  ), col AS (
    SELECT ac.agent_id, COALESCE(sum(ac.amount),0) collected, count(*) txns
    FROM agent_collections ac
    WHERE ac.created_at BETWEEN p_from AND p_to
    GROUP BY ac.agent_id
  )
  SELECT jsonb_agg(x)
  INTO v_capacity
  FROM (
    SELECT jsonb_build_object(
      'agent', COALESCE(p.full_name, 'Unknown'),
      'phone', p.phone,
      'active_plans', cap.active_plans,
      'expected_daily', cap.expected_daily,
      'collected', COALESCE(col.collected,0),
      'txns', COALESCE(col.txns,0)
    ) x
    FROM cap
    LEFT JOIN col ON col.agent_id = cap.agent_id
    LEFT JOIN profiles p ON p.id = cap.agent_id
    WHERE cap.active_plans > 0
    ORDER BY cap.expected_daily DESC
    LIMIT 20
  ) q;

  RETURN jsonb_build_object(
    'window', v_window,
    'daily', COALESCE(v_days, '[]'::jsonb),
    'missed', v_missed,
    'pipeline', v_pipeline,
    'capacity', COALESCE(v_capacity, '[]'::jsonb),
    'from', p_from,
    'to', p_to
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.ops_tenant_ops_weekly_bundle(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_tenant_ops_weekly_bundle(timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.ops_tenant_ops_weekly_bundle(timestamptz, timestamptz) TO authenticated;
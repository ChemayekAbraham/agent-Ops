
CREATE OR REPLACE FUNCTION public.agent_ops_report_rent_collections(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_rows jsonb; v_sum record;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  WITH exp AS (
    SELECT e.agent_id,
           SUM(e.expected_ugx) AS expected,
           COUNT(DISTINCT e.rent_request_id) AS repaying_tenants
    FROM public.agent_expected_day_plans e
    WHERE e.day BETWEEN p_from AND p_to
    GROUP BY e.agent_id
  ), got AS (
    SELECT ac.agent_id,
           SUM(ac.amount) AS collected,
           COUNT(*) AS payments,
           COUNT(DISTINCT COALESCE(ac.rent_request_id, ac.tenant_id)) AS paid_tenants
    FROM public.agent_collections ac
    WHERE ac.amount > 0
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
    GROUP BY ac.agent_id
  ), merged AS (
    SELECT COALESCE(e.agent_id, g.agent_id) AS agent_id,
           COALESCE(e.expected,0) AS expected,
           COALESCE(e.repaying_tenants,0) AS repaying_tenants,
           COALESCE(g.collected,0) AS collected,
           COALESCE(g.payments,0) AS payments,
           COALESCE(g.paid_tenants,0) AS paid_tenants
    FROM exp e FULL OUTER JOIN got g ON g.agent_id = e.agent_id
    WHERE COALESCE(e.agent_id, g.agent_id) IS NOT NULL
  ), scored AS (
    SELECT m.*, p.full_name, p.phone,
           CASE WHEN m.expected > 0 THEN ROUND(m.collected*100.0/m.expected,1) END AS rate
    FROM merged m LEFT JOIN public.profiles p ON p.id = m.agent_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_id', s.agent_id,
           'full_name', s.full_name,
           'phone', s.phone,
           'repaying_tenants', s.repaying_tenants,
           'expected', s.expected,
           'collected', s.collected,
           'payments', s.payments,
           'paid_tenants', s.paid_tenants,
           'rate', s.rate,
           'status', CASE
             WHEN s.collected <= 0 THEN 'Silent'
             WHEN s.rate IS NULL THEN 'Unscheduled'
             WHEN s.rate >= 100 THEN 'Excellent'
             WHEN s.rate >= 75 THEN 'On track'
             WHEN s.rate >= 50 THEN 'Fair'
             ELSE 'Behind' END
         ) ORDER BY s.collected DESC NULLS LAST), '[]'::jsonb)
    INTO v_rows
  FROM scored s;

  SELECT
    (SELECT COUNT(DISTINCT e.agent_id) FROM public.agent_expected_day_plans e WHERE e.day BETWEEN p_from AND p_to) AS total_agents,
    (SELECT COUNT(DISTINCT ac.agent_id) FROM public.agent_collections ac WHERE ac.amount > 0 AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to) AS active_agents,
    (SELECT COALESCE(SUM(e.expected_ugx),0) FROM public.agent_expected_day_plans e WHERE e.day BETWEEN p_from AND p_to) AS expected,
    (SELECT COALESCE(SUM(ac.amount),0) FROM public.agent_collections ac WHERE ac.amount > 0 AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to) AS collected,
    (SELECT COUNT(DISTINCT e.rent_request_id) FROM public.agent_expected_day_plans e WHERE e.day BETWEEN p_from AND p_to) AS repaying_tenants
  INTO v_sum;

  RETURN jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'kpis', jsonb_build_object(
      'total_agents', v_sum.total_agents,
      'active_agents', v_sum.active_agents,
      'expected', v_sum.expected,
      'collected', v_sum.collected,
      'repaying_tenants', v_sum.repaying_tenants,
      'collection_rate', CASE WHEN v_sum.expected > 0 THEN ROUND(v_sum.collected*100.0/v_sum.expected,1) END
    ),
    'rows', v_rows
  );
END;
$$;

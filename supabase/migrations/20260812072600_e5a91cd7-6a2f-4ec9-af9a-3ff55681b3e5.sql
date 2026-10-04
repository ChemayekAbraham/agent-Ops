CREATE OR REPLACE FUNCTION public.get_agent_collections_command_center(
  p_start timestamptz,
  p_end timestamptz,
  p_bucket text DEFAULT 'day'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bucket text := lower(coalesce(p_bucket, 'day'));
  v_start timestamptz := p_start;
  v_end timestamptz := p_end;
  v_days numeric;
  v_totals jsonb;
  v_series jsonb;
  v_hours jsonb;
  v_agents jsonb;
BEGIN
  IF NOT (
    has_role(auth.uid(), 'manager') OR has_role(auth.uid(), 'super_admin')
    OR has_role(auth.uid(), 'ceo') OR has_role(auth.uid(), 'coo')
    OR has_role(auth.uid(), 'cfo') OR has_role(auth.uid(), 'operations')
    OR has_role(auth.uid(), 'agent_ops')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start THEN
    RAISE EXCEPTION 'invalid range';
  END IF;

  IF v_bucket NOT IN ('hour','day','week','month') THEN
    v_bucket := 'day';
  END IF;

  v_days := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_end - v_start)) / 86400.0));

  -- Totals
  SELECT jsonb_build_object(
    'collected', COALESCE(c.amt, 0),
    'collections_count', COALESCE(c.cnt, 0),
    'active_agents', COALESCE(c.agents, 0),
    'tenants_paid', COALESCE(c.tenants, 0),
    'avg_collection', CASE WHEN COALESCE(c.cnt,0) > 0 THEN ROUND(COALESCE(c.amt,0) / c.cnt) ELSE 0 END,
    'requests_count', COALESCE(r.cnt, 0),
    'requests_amount', COALESCE(r.amt, 0),
    'days', v_days
  )
  INTO v_totals
  FROM (
    SELECT SUM(ac.amount) AS amt, COUNT(*) AS cnt,
           COUNT(DISTINCT ac.agent_id) AS agents, COUNT(DISTINCT ac.tenant_id) AS tenants
    FROM agent_collections ac
    WHERE ac.created_at >= v_start AND ac.created_at < v_end AND ac.amount > 0
  ) c
  CROSS JOIN (
    SELECT COUNT(*) AS cnt, SUM(rr.rent_amount) AS amt
    FROM rent_requests rr
    WHERE rr.created_at >= v_start AND rr.created_at < v_end
      AND COALESCE(rr.status,'') NOT IN ('deleted_by_agent','rejected')
  ) r;

  -- Time series (collections vs rent requests), bucketed in EAT
  WITH buckets AS (
    SELECT generate_series(
      date_trunc(v_bucket, v_start AT TIME ZONE 'Africa/Kampala'),
      date_trunc(v_bucket, (v_end - interval '1 microsecond') AT TIME ZONE 'Africa/Kampala'),
      ('1 ' || v_bucket)::interval
    ) AS b
  ),
  col AS (
    SELECT date_trunc(v_bucket, ac.created_at AT TIME ZONE 'Africa/Kampala') AS b,
           SUM(ac.amount) AS amt, COUNT(*) AS cnt
    FROM agent_collections ac
    WHERE ac.created_at >= v_start AND ac.created_at < v_end AND ac.amount > 0
    GROUP BY 1
  ),
  req AS (
    SELECT date_trunc(v_bucket, rr.created_at AT TIME ZONE 'Africa/Kampala') AS b,
           SUM(rr.rent_amount) AS amt, COUNT(*) AS cnt
    FROM rent_requests rr
    WHERE rr.created_at >= v_start AND rr.created_at < v_end
      AND COALESCE(rr.status,'') NOT IN ('deleted_by_agent','rejected')
    GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'bucket', to_char(bk.b, CASE WHEN v_bucket = 'hour' THEN 'YYYY-MM-DD HH24:00'
                                 WHEN v_bucket = 'month' THEN 'YYYY-MM'
                                 ELSE 'YYYY-MM-DD' END),
    'collected', COALESCE(c.amt, 0),
    'collections_count', COALESCE(c.cnt, 0),
    'requests_amount', COALESCE(r.amt, 0),
    'requests_count', COALESCE(r.cnt, 0)
  ) ORDER BY bk.b), '[]'::jsonb)
  INTO v_series
  FROM buckets bk
  LEFT JOIN col c ON c.b = bk.b
  LEFT JOIN req r ON r.b = bk.b;

  -- Peak hours of collections (0-23, EAT)
  WITH hrs AS (SELECT generate_series(0, 23) AS h),
  agg AS (
    SELECT EXTRACT(HOUR FROM ac.created_at AT TIME ZONE 'Africa/Kampala')::int AS h,
           SUM(ac.amount) AS amt, COUNT(*) AS cnt
    FROM agent_collections ac
    WHERE ac.created_at >= v_start AND ac.created_at < v_end AND ac.amount > 0
    GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'hour', hrs.h,
    'amount', COALESCE(agg.amt, 0),
    'count', COALESCE(agg.cnt, 0)
  ) ORDER BY hrs.h), '[]'::jsonb)
  INTO v_hours
  FROM hrs LEFT JOIN agg ON agg.h = hrs.h;

  -- Per-agent collected vs expected
  WITH col AS (
    SELECT ac.agent_id, SUM(ac.amount) AS amt, COUNT(*) AS cnt,
           COUNT(DISTINCT ac.tenant_id) AS tenants, MAX(ac.created_at) AS last_at
    FROM agent_collections ac
    WHERE ac.created_at >= v_start AND ac.created_at < v_end AND ac.amount > 0
    GROUP BY 1
  ),
  exp_hist AS (
    SELECT h.agent_id, SUM(h.expected_daily) AS expected
    FROM agent_daily_eligibility_history h
    WHERE h.day >= (v_start AT TIME ZONE 'Africa/Kampala')::date
      AND h.day <= ((v_end - interval '1 microsecond') AT TIME ZONE 'Africa/Kampala')::date
    GROUP BY 1
  ),
  ids AS (
    SELECT agent_id FROM col
    UNION SELECT agent_id FROM exp_hist
    UNION SELECT e.agent_id FROM v_agent_daily_eligibility e WHERE e.expected_daily > 0
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'agent_id', i.agent_id,
    'name', COALESCE(p.full_name, 'Unnamed agent'),
    'phone', p.phone,
    'avatar_url', p.avatar_url,
    'collected', COALESCE(c.amt, 0),
    'collections_count', COALESCE(c.cnt, 0),
    'tenants_paid', COALESCE(c.tenants, 0),
    'active_tenants', COALESCE(e.active_count, 0),
    'expected_daily', COALESCE(e.expected_daily, 0),
    'expected', COALESCE(eh.expected, COALESCE(e.expected_daily, 0) * v_days),
    'expected_source', CASE WHEN eh.expected IS NOT NULL THEN 'history' ELSE 'projected' END,
    'last_collection_at', c.last_at
  ) ORDER BY COALESCE(c.amt, 0) DESC), '[]'::jsonb)
  INTO v_agents
  FROM ids i
  LEFT JOIN col c ON c.agent_id = i.agent_id
  LEFT JOIN exp_hist eh ON eh.agent_id = i.agent_id
  LEFT JOIN v_agent_daily_eligibility e ON e.agent_id = i.agent_id
  LEFT JOIN profiles p ON p.id = i.agent_id;

  RETURN jsonb_build_object(
    'range', jsonb_build_object('start', v_start, 'end', v_end, 'bucket', v_bucket),
    'totals', v_totals,
    'series', v_series,
    'peak_hours', v_hours,
    'agents', v_agents,
    'generated_at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_agent_collections_command_center(timestamptz, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agent_collections_command_center(timestamptz, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_collections_command_center(timestamptz, timestamptz, text) TO service_role;
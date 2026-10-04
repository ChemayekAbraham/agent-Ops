
-- RPC: Search tenants with repayment behavior summary (for Tenant Ops at scale)
CREATE OR REPLACE FUNCTION public.search_tenant_behavior(
  p_search TEXT DEFAULT NULL,
  p_segment TEXT DEFAULT 'all',
  p_limit INT DEFAULT 20,
  p_offset INT DEFAULT 0
)
RETURNS TABLE(
  tenant_id UUID,
  full_name TEXT,
  phone TEXT,
  total_requests BIGINT,
  total_rent_amount NUMERIC,
  total_repaid NUMERIC,
  repayment_pct NUMERIC,
  active_requests BIGINT,
  fully_repaid_count BIGINT,
  defaulted_count BIGINT,
  missed_payments BIGINT,
  on_time_payments BIGINT,
  health_score NUMERIC,
  risk_level TEXT,
  current_overdue_amount NUMERIC,
  last_payment_date TIMESTAMPTZ,
  first_request_date TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH tenant_requests AS (
    SELECT
      rr.user_id,
      COUNT(*) AS total_requests,
      COALESCE(SUM(rr.rent_amount), 0) AS total_rent_amount,
      COALESCE(SUM(rr.amount_repaid), 0) AS total_repaid,
      COUNT(*) FILTER (WHERE rr.status IN ('repaying', 'funded', 'disbursed')) AS active_requests,
      COUNT(*) FILTER (WHERE rr.status = 'fully_repaid') AS fully_repaid_count,
      COUNT(*) FILTER (WHERE rr.status = 'defaulted') AS defaulted_count,
      MIN(rr.created_at) AS first_request_date
    FROM rent_requests rr
    WHERE rr.user_id IS NOT NULL
    GROUP BY rr.user_id
  ),
  schedule_stats AS (
    SELECT
      rr.user_id,
      COUNT(*) FILTER (WHERE rs.status = 'missed') AS missed_payments,
      COUNT(*) FILTER (WHERE rs.status = 'paid') AS on_time_payments
    FROM rent_requests rr
    JOIN repayment_schedule rs ON rs.rent_request_id = rr.id
    WHERE rr.user_id IS NOT NULL
    GROUP BY rr.user_id
  ),
  overdue AS (
    SELECT
      rr.user_id,
      COALESCE(SUM(rr.rent_amount - rr.amount_repaid), 0) AS current_overdue_amount
    FROM rent_requests rr
    WHERE rr.status IN ('repaying', 'funded', 'disbursed')
      AND rr.amount_repaid < rr.rent_amount
      AND rr.user_id IS NOT NULL
    GROUP BY rr.user_id
  ),
  last_pay AS (
    SELECT
      ac.tenant_id AS user_id,
      MAX(ac.created_at) AS last_payment_date
    FROM agent_collections ac
    GROUP BY ac.tenant_id
  ),
  combined AS (
    SELECT
      p.id AS tenant_id,
      p.full_name,
      p.phone,
      COALESCE(tr.total_requests, 0) AS total_requests,
      COALESCE(tr.total_rent_amount, 0) AS total_rent_amount,
      COALESCE(tr.total_repaid, 0) AS total_repaid,
      CASE WHEN COALESCE(tr.total_rent_amount, 0) > 0
        THEN ROUND((COALESCE(tr.total_repaid, 0) / tr.total_rent_amount) * 100, 1)
        ELSE 0 END AS repayment_pct,
      COALESCE(tr.active_requests, 0) AS active_requests,
      COALESCE(tr.fully_repaid_count, 0) AS fully_repaid_count,
      COALESCE(tr.defaulted_count, 0) AS defaulted_count,
      COALESCE(ss.missed_payments, 0) AS missed_payments,
      COALESCE(ss.on_time_payments, 0) AS on_time_payments,
      -- Health score: weighted formula
      CASE WHEN (COALESCE(ss.on_time_payments, 0) + COALESCE(ss.missed_payments, 0)) > 0
        THEN ROUND(
          (COALESCE(ss.on_time_payments, 0)::NUMERIC / (ss.on_time_payments + ss.missed_payments)) * 70 +
          (COALESCE(tr.fully_repaid_count, 0)::NUMERIC / GREATEST(tr.total_requests, 1)) * 30,
          1
        )
        ELSE 50 END AS health_score,
      COALESCE(ov.current_overdue_amount, 0) AS current_overdue_amount,
      lp.last_payment_date,
      tr.first_request_date
    FROM profiles p
    JOIN user_roles ur ON ur.user_id = p.id AND ur.role = 'tenant' AND ur.enabled = true
    LEFT JOIN tenant_requests tr ON tr.user_id = p.id
    LEFT JOIN schedule_stats ss ON ss.user_id = p.id
    LEFT JOIN overdue ov ON ov.user_id = p.id
    LEFT JOIN last_pay lp ON lp.user_id = p.id
    WHERE tr.total_requests > 0
  )
  SELECT
    c.tenant_id, c.full_name, c.phone,
    c.total_requests, c.total_rent_amount, c.total_repaid, c.repayment_pct,
    c.active_requests, c.fully_repaid_count, c.defaulted_count,
    c.missed_payments, c.on_time_payments, c.health_score,
    CASE
      WHEN c.defaulted_count > 0 OR c.health_score < 30 THEN 'critical'
      WHEN c.missed_payments > 2 OR c.health_score < 60 THEN 'warning'
      ELSE 'healthy'
    END AS risk_level,
    c.current_overdue_amount, c.last_payment_date, c.first_request_date
  FROM combined c
  WHERE
    (p_search IS NULL OR p_search = '' OR
     c.full_name ILIKE '%' || p_search || '%' OR
     c.phone ILIKE '%' || p_search || '%')
    AND (
      p_segment = 'all'
      OR (p_segment = 'critical' AND (c.defaulted_count > 0 OR c.health_score < 30))
      OR (p_segment = 'warning' AND c.missed_payments > 2 AND c.defaulted_count = 0)
      OR (p_segment = 'healthy' AND c.health_score >= 60 AND c.defaulted_count = 0)
      OR (p_segment = 'first_default' AND c.defaulted_count = 1 AND c.fully_repaid_count = 0)
      OR (p_segment = 'recovering' AND c.fully_repaid_count > 0 AND c.active_requests > 0)
      OR (p_segment = 'overdue' AND c.current_overdue_amount > 0)
    )
  ORDER BY
    CASE WHEN p_segment = 'all' AND (p_search IS NULL OR p_search = '') THEN c.health_score ELSE NULL END ASC NULLS LAST,
    CASE WHEN p_search IS NOT NULL AND p_search != '' THEN c.full_name ELSE NULL END ASC NULLS LAST,
    c.current_overdue_amount DESC NULLS LAST
  LIMIT p_limit OFFSET p_offset;
END;
$$;

-- RPC: Get aggregate segment counts for KPI strip
CREATE OR REPLACE FUNCTION public.get_tenant_behavior_segments()
RETURNS TABLE(
  total_with_requests BIGINT,
  critical_count BIGINT,
  warning_count BIGINT,
  healthy_count BIGINT,
  first_default_count BIGINT,
  recovering_count BIGINT,
  overdue_count BIGINT,
  total_overdue_amount NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH tenant_agg AS (
    SELECT
      rr.user_id,
      COUNT(*) AS total_requests,
      COALESCE(SUM(rr.rent_amount), 0) AS total_rent,
      COALESCE(SUM(rr.amount_repaid), 0) AS total_repaid,
      COUNT(*) FILTER (WHERE rr.status = 'fully_repaid') AS fully_repaid_count,
      COUNT(*) FILTER (WHERE rr.status = 'defaulted') AS defaulted_count,
      COUNT(*) FILTER (WHERE rr.status IN ('repaying','funded','disbursed')) AS active_requests,
      COALESCE(SUM(CASE WHEN rr.status IN ('repaying','funded','disbursed') AND rr.amount_repaid < rr.rent_amount THEN rr.rent_amount - rr.amount_repaid ELSE 0 END), 0) AS overdue_amt
    FROM rent_requests rr
    WHERE rr.user_id IS NOT NULL
    GROUP BY rr.user_id
  ),
  with_schedule AS (
    SELECT
      ta.user_id,
      ta.*,
      COALESCE(ss.missed, 0) AS missed,
      COALESCE(ss.paid, 0) AS paid,
      CASE WHEN (COALESCE(ss.paid,0) + COALESCE(ss.missed,0)) > 0
        THEN (ss.paid::NUMERIC / (ss.paid + ss.missed)) * 70 + (ta.fully_repaid_count::NUMERIC / GREATEST(ta.total_requests,1)) * 30
        ELSE 50 END AS health
    FROM tenant_agg ta
    LEFT JOIN (
      SELECT rr.user_id,
        COUNT(*) FILTER (WHERE rs.status='missed') AS missed,
        COUNT(*) FILTER (WHERE rs.status='paid') AS paid
      FROM rent_requests rr JOIN repayment_schedule rs ON rs.rent_request_id = rr.id
      WHERE rr.user_id IS NOT NULL GROUP BY rr.user_id
    ) ss ON ss.user_id = ta.user_id
  )
  SELECT
    COUNT(*)::BIGINT AS total_with_requests,
    COUNT(*) FILTER (WHERE ws.defaulted_count > 0 OR ws.health < 30)::BIGINT AS critical_count,
    COUNT(*) FILTER (WHERE ws.missed > 2 AND ws.defaulted_count = 0 AND ws.health >= 30)::BIGINT AS warning_count,
    COUNT(*) FILTER (WHERE ws.health >= 60 AND ws.defaulted_count = 0)::BIGINT AS healthy_count,
    COUNT(*) FILTER (WHERE ws.defaulted_count = 1 AND ws.fully_repaid_count = 0)::BIGINT AS first_default_count,
    COUNT(*) FILTER (WHERE ws.fully_repaid_count > 0 AND ws.active_requests > 0)::BIGINT AS recovering_count,
    COUNT(*) FILTER (WHERE ws.overdue_amt > 0)::BIGINT AS overdue_count,
    COALESCE(SUM(ws.overdue_amt), 0)::NUMERIC AS total_overdue_amount
  FROM with_schedule ws;
END;
$$;

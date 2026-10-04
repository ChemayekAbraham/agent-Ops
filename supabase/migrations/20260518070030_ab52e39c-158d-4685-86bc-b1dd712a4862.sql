CREATE OR REPLACE FUNCTION public.get_tenant_missed_dates(
  p_window_days integer,
  p_as_of date DEFAULT CURRENT_DATE
)
RETURNS TABLE (tenant_id uuid, missed_dates date[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH window_days AS (
    SELECT generate_series(
      (p_as_of - (GREATEST(p_window_days, 1) - 1) * INTERVAL '1 day')::date,
      p_as_of,
      INTERVAL '1 day'
    )::date AS d
  ),
  active_tenants AS (
    SELECT
      rr.tenant_id,
      MIN(rr.created_at)::date AS earliest_active,
      COALESCE(MAX(rr.daily_repayment), 0)::numeric AS daily_expected
    FROM public.rent_requests rr
    WHERE rr.status IN ('funded', 'disbursed', 'repaying')
      AND rr.created_at::date <= p_as_of
    GROUP BY rr.tenant_id
  ),
  daily_paid AS (
    SELECT
      ac.tenant_id,
      (ac.created_at AT TIME ZONE 'UTC')::date AS pd,
      SUM(ac.amount)::numeric AS paid_amount
    FROM public.agent_collections ac
    WHERE ac.amount > 0
      AND ac.created_at >= (p_as_of - (GREATEST(p_window_days, 1) - 1) * INTERVAL '1 day')
      AND ac.created_at <  (p_as_of + INTERVAL '1 day')
    GROUP BY ac.tenant_id, (ac.created_at AT TIME ZONE 'UTC')::date
  ),
  expanded AS (
    SELECT at.tenant_id, at.daily_expected, wd.d
    FROM active_tenants at
    CROSS JOIN window_days wd
    WHERE wd.d >= at.earliest_active
  ),
  missed AS (
    SELECT e.tenant_id, e.d
    FROM expanded e
    WHERE NOT EXISTS (
      SELECT 1 FROM daily_paid p
      WHERE p.tenant_id = e.tenant_id
        AND p.pd = e.d
        AND (e.daily_expected <= 0 OR p.paid_amount >= e.daily_expected)
    )
  )
  SELECT tenant_id, ARRAY_AGG(d ORDER BY d DESC) AS missed_dates
  FROM missed
  GROUP BY tenant_id;
$$;

REVOKE ALL ON FUNCTION public.get_tenant_missed_dates(integer, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_tenant_missed_dates(integer, date) TO authenticated, service_role;
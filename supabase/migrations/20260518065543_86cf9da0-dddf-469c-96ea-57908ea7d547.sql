-- Fast per-tenant missed-days aggregator for the Daily Collection Tracker.
-- Computes server-side so the dashboard doesn't page through agent_collections.

CREATE OR REPLACE FUNCTION public.get_tenant_missed_days(
  p_window_days integer,
  p_as_of date DEFAULT CURRENT_DATE
)
RETURNS TABLE (tenant_id uuid, missed_days integer)
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
      MIN(rr.created_at)::date AS earliest_active
    FROM public.rent_requests rr
    WHERE rr.status IN ('funded', 'disbursed', 'repaying')
      AND rr.created_at::date <= p_as_of
    GROUP BY rr.tenant_id
  ),
  paid_days AS (
    SELECT
      ac.tenant_id,
      (ac.created_at AT TIME ZONE 'UTC')::date AS pd
    FROM public.agent_collections ac
    WHERE ac.amount > 0
      AND ac.created_at >= (p_as_of - (GREATEST(p_window_days, 1) - 1) * INTERVAL '1 day')
      AND ac.created_at <  (p_as_of + INTERVAL '1 day')
    GROUP BY ac.tenant_id, (ac.created_at AT TIME ZONE 'UTC')::date
  ),
  expanded AS (
    SELECT at.tenant_id, wd.d
    FROM active_tenants at
    CROSS JOIN window_days wd
    WHERE wd.d >= at.earliest_active
  )
  SELECT
    e.tenant_id,
    COUNT(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1 FROM paid_days p
        WHERE p.tenant_id = e.tenant_id AND p.pd = e.d
      )
    )::int AS missed_days
  FROM expanded e
  GROUP BY e.tenant_id
  HAVING COUNT(*) FILTER (
    WHERE NOT EXISTS (
      SELECT 1 FROM paid_days p
      WHERE p.tenant_id = e.tenant_id AND p.pd = e.d
    )
  ) > 0;
$$;

REVOKE ALL ON FUNCTION public.get_tenant_missed_days(integer, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_tenant_missed_days(integer, date) TO authenticated, service_role;

-- Supporting index for the window scan (idempotent)
CREATE INDEX IF NOT EXISTS idx_agent_collections_created_at_tenant
  ON public.agent_collections (created_at, tenant_id)
  WHERE amount > 0;
CREATE OR REPLACE FUNCTION public.tenant_location_correction_active_metrics(p_agent_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  WITH base AS (
    -- Identical population rule to tenant_location_correction_dashboard:
    -- the latest rent request decides the handling agent for a tenant.
    SELECT DISTINCT ON (r.tenant_id)
      r.tenant_id,
      coalesce(r.agent_id, r.assigned_agent_id) AS agent_id
    FROM public.rent_requests r
    WHERE r.tenant_id IS NOT NULL
    ORDER BY r.tenant_id, r.created_at DESC
  ), active AS (
    -- Existing system definition of an active rent relationship.
    SELECT DISTINCT r.tenant_id
    FROM public.rent_requests r
    WHERE r.tenant_id IS NOT NULL
      AND r.status IN ('funded', 'disbursed', 'repaying')
  ), pop AS (
    SELECT
      b.tenant_id,
      b.agent_id,
      (tp.ug_village_id IS NULL) AS outstanding,
      (a.tenant_id IS NOT NULL) AS is_active
    FROM base b
    JOIN public.profiles tp ON tp.id = b.tenant_id
    LEFT JOIN active a ON a.tenant_id = b.tenant_id
    WHERE p_agent_id IS NULL OR b.agent_id = p_agent_id
  ), t AS (
    SELECT
      count(*)::int AS total_tenants,
      count(*) FILTER (WHERE is_active)::int AS active_tenants,
      count(*) FILTER (WHERE is_active AND NOT outstanding)::int AS active_corrected,
      count(*) FILTER (WHERE is_active AND outstanding)::int AS active_outstanding,
      count(*) FILTER (WHERE outstanding)::int AS total_outstanding
    FROM pop
  )
  SELECT jsonb_build_object(
    'total_tenants', t.total_tenants,
    'active_tenants', t.active_tenants,
    'active_corrected', t.active_corrected,
    'active_outstanding', t.active_outstanding,
    'total_outstanding', t.total_outstanding,
    'active_pct_corrected', CASE WHEN t.active_tenants > 0
      THEN round(t.active_corrected::numeric * 100 / t.active_tenants, 1) ELSE 0 END,
    'active_share_of_population', CASE WHEN t.total_tenants > 0
      THEN round(t.active_tenants::numeric * 100 / t.total_tenants, 1) ELSE 0 END,
    'active_share_of_outstanding', CASE WHEN t.total_outstanding > 0
      THEN round(t.active_outstanding::numeric * 100 / t.total_outstanding, 1) ELSE 0 END
  ) INTO v_result
  FROM t;

  RETURN coalesce(v_result, '{}'::jsonb);
END;
$$;
-- Replace the flat 100k floor with a logarithmic, tenant-scaled base.
-- Formula: 100,000 * (1 + log2(tenants)) where tenants = count of distinct
-- tenants linked to the agent via an active rent_request.
-- 0 tenants -> 100,000 (preserves existing universal floor)
-- 1 tenant  -> 100,000
-- 2 tenants -> 200,000
-- 4 tenants -> 300,000
-- 8 tenants -> 400,000
-- Capped at UGX 30,000,000.

CREATE OR REPLACE FUNCTION public.welile_default_agent_vouch_floor_ugx(p_agent_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenants integer := 0;
  v_floor numeric := 100000;
  v_cap numeric := 30000000;
BEGIN
  IF p_agent_id IS NULL THEN
    RETURN v_floor;
  END IF;

  -- Count distinct tenants linked to this agent via an active rent_request.
  -- "Active" = not cancelled/rejected/closed.
  SELECT COUNT(DISTINCT rr.tenant_id)
    INTO v_tenants
  FROM public.rent_requests rr
  WHERE rr.agent_id = p_agent_id
    AND rr.tenant_id IS NOT NULL
    AND COALESCE(rr.status, '') NOT IN ('cancelled', 'rejected', 'closed', 'declined', 'expired');

  IF v_tenants <= 1 THEN
    RETURN v_floor;
  END IF;

  -- Logarithmic scaling: 100k * (1 + log2(tenants))
  v_floor := 100000 * (1 + (ln(v_tenants::numeric) / ln(2)));

  -- Round to nearest 1,000 for clean display
  v_floor := ROUND(v_floor / 1000) * 1000;

  -- Cap at advance-engine ceiling
  IF v_floor > v_cap THEN
    v_floor := v_cap;
  END IF;

  RETURN v_floor;
END;
$$;
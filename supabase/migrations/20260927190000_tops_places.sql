-- Tenant Ops Workspace — Places tab. Per docs/TOPS_RULES.md: the
-- administrative chain itself (region -> district -> county -> subcounty ->
-- parish -> village) is read EXCLUSIVELY through the existing, already-built
-- resolver view v_tlb_tenant_base (which already handles every fallback —
-- ug_village_id, then district_id, then Unmapped — so none of that
-- resolution logic is re-derived here). No new geo aggregation is built for
-- the hierarchy itself; the two new functions below only ADD a money-at-risk
-- reading and an agent-coverage reading on top of that existing resolution,
-- which nothing existing already provides.
--
-- The existing hierarchy browsers themselves — tlb_children / tlb_tenants /
-- tlb_search_locations — are called directly by the new frontend hooks with
-- no new backend object at all: they are already GRANT EXECUTE TO
-- authenticated with no narrower role gate, so no tops_ wrapper is needed to
-- reach them from this tab.

-- ---------------------------------------------------------------------------
-- 1. tops_area_book(p_level, p_as_at) — arrears rate and money at risk per
--    area, from tops_plan_instalments (via the existing internal helper
--    tops_open_instalments_asof, which every other arrears reading in this
--    build already shares one definition through). Grouped by whichever
--    administrative level the caller asks for; a tenant with no resolvable
--    location groups into the "Unmapped" bucket at every level, exactly the
--    same convention v_tlb_tenant_base itself already uses.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_area_book(p_level text, p_as_at date DEFAULT NULL)
RETURNS TABLE (
  area_key text,
  area_name text,
  region text,
  plan_count integer,
  arrears_plan_count integer,
  arrears_rate numeric,
  money_at_risk_ugx numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_at date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF p_level NOT IN ('region', 'district', 'county', 'subcounty', 'parish', 'village') THEN
    RAISE EXCEPTION 'invalid level: %, expected region/district/county/subcounty/parish/village', p_level;
  END IF;

  RETURN QUERY
  WITH tenant_area AS (
    SELECT
      tb.tenant_id,
      tb.region,
      CASE p_level
        WHEN 'region' THEN tb.region
        WHEN 'district' THEN tb.district_id::text
        WHEN 'county' THEN tb.county_id::text
        WHEN 'subcounty' THEN tb.subcounty_id::text
        WHEN 'parish' THEN tb.parish_id::text
        WHEN 'village' THEN tb.village_id::text
      END AS area_key,
      CASE p_level
        WHEN 'region' THEN tb.region
        WHEN 'district' THEN tb.district_name
        WHEN 'county' THEN tb.county_name
        WHEN 'subcounty' THEN tb.subcounty_name
        WHEN 'parish' THEN tb.parish_name
        WHEN 'village' THEN tb.village_name
      END AS area_name
    FROM public.v_tlb_tenant_base tb
  ),
  plans AS (
    SELECT rr.id AS rent_request_id, rr.tenant_id
    FROM public.rent_requests rr
    WHERE rr.status IN ('funded', 'repaying')
  ),
  arrears AS (
    SELECT o.rent_request_id, SUM(o.outstanding_ugx) AS outstanding_ugx
    FROM public.tops_open_instalments_asof(v_as_at) o
    WHERE NOT o.never_billed
    GROUP BY o.rent_request_id
  )
  SELECT
    ta.area_key,
    COALESCE(ta.area_name, 'Unmapped'),
    ta.region,
    count(DISTINCT p.rent_request_id)::integer,
    count(DISTINCT p.rent_request_id) FILTER (WHERE COALESCE(a.outstanding_ugx, 0) > 0)::integer,
    ROUND(
      count(DISTINCT p.rent_request_id) FILTER (WHERE COALESCE(a.outstanding_ugx, 0) > 0)::numeric
      / NULLIF(count(DISTINCT p.rent_request_id), 0), 4
    ),
    COALESCE(SUM(a.outstanding_ugx), 0)
  FROM plans p
  JOIN tenant_area ta ON ta.tenant_id = p.tenant_id
  LEFT JOIN arrears a ON a.rent_request_id = p.rent_request_id
  GROUP BY ta.area_key, ta.area_name, ta.region
  ORDER BY 7 DESC NULLS LAST;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_area_book(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_area_book(text, date) TO authenticated;

COMMENT ON FUNCTION public.tops_area_book(text, date) IS
'Arrears rate and money at risk per administrative area (region/district/county/subcounty/parish/village), from tops_plan_instalments via tops_open_instalments_asof — the same internal helper tops_arrears_ageing already shares. Area resolution comes entirely from the EXISTING v_tlb_tenant_base view (no new geo/location resolution logic); a tenant that view cannot resolve at the requested level groups into "Unmapped". Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 2. tops_agent_area_coverage(p_level) — which agents cover which area, and
--    how many live plans each holds there. Same area resolution as above.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_agent_area_coverage(p_level text DEFAULT 'district')
RETURNS TABLE (
  area_key text,
  area_name text,
  agent_id uuid,
  agent_name text,
  plan_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF p_level NOT IN ('region', 'district', 'county', 'subcounty', 'parish', 'village') THEN
    RAISE EXCEPTION 'invalid level: %, expected region/district/county/subcounty/parish/village', p_level;
  END IF;

  RETURN QUERY
  WITH tenant_area AS (
    SELECT
      tb.tenant_id,
      CASE p_level
        WHEN 'region' THEN tb.region
        WHEN 'district' THEN tb.district_id::text
        WHEN 'county' THEN tb.county_id::text
        WHEN 'subcounty' THEN tb.subcounty_id::text
        WHEN 'parish' THEN tb.parish_id::text
        WHEN 'village' THEN tb.village_id::text
      END AS area_key,
      CASE p_level
        WHEN 'region' THEN tb.region
        WHEN 'district' THEN tb.district_name
        WHEN 'county' THEN tb.county_name
        WHEN 'subcounty' THEN tb.subcounty_name
        WHEN 'parish' THEN tb.parish_name
        WHEN 'village' THEN tb.village_name
      END AS area_name
    FROM public.v_tlb_tenant_base tb
  )
  SELECT
    ta.area_key,
    COALESCE(ta.area_name, 'Unmapped'),
    COALESCE(rr.assigned_agent_id, rr.agent_id),
    ap.full_name,
    count(*)::integer
  FROM public.rent_requests rr
  JOIN tenant_area ta ON ta.tenant_id = rr.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = COALESCE(rr.assigned_agent_id, rr.agent_id)
  WHERE rr.status IN ('funded', 'repaying')
    AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
  GROUP BY ta.area_key, ta.area_name, COALESCE(rr.assigned_agent_id, rr.agent_id), ap.full_name
  ORDER BY ta.area_name NULLS LAST, count(*) DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_agent_area_coverage(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_agent_area_coverage(text) TO authenticated;

COMMENT ON FUNCTION public.tops_agent_area_coverage(text) IS
'Which agents hold live (funded/repaying) plans in each administrative area, and how many. Same v_tlb_tenant_base-only area resolution as tops_area_book — no new geo logic. Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 3. tops_unmapped_tenants_worklist(p_limit) — a FINITE worklist (capped),
--    not an open-ended query. "Unmapped" matches v_tlb_tenant_base's own
--    definition (district_id IS NULL) — the same bar tlb_children already
--    uses for its own Unmapped bucket at the top level.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_unmapped_tenants_worklist(p_limit integer DEFAULT 200)
RETURNS TABLE (
  rent_request_id uuid,
  tenant_id uuid,
  tenant_name text,
  agent_id uuid,
  agent_name text,
  legacy_location text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    rr.id,
    rr.tenant_id,
    tb.tenant_name,
    COALESCE(rr.assigned_agent_id, rr.agent_id),
    ap.full_name,
    tb.legacy_location
  FROM public.rent_requests rr
  JOIN public.v_tlb_tenant_base tb ON tb.tenant_id = rr.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = COALESCE(rr.assigned_agent_id, rr.agent_id)
  WHERE rr.status IN ('funded', 'repaying')
    AND tb.district_id IS NULL
  ORDER BY rr.created_at ASC
  LIMIT GREATEST(p_limit, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.tops_unmapped_tenants_worklist(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_unmapped_tenants_worklist(integer) TO authenticated;

COMMENT ON FUNCTION public.tops_unmapped_tenants_worklist(integer) IS
'A finite (LIMIT-capped, default 200), oldest-first worklist of tenants on a live plan with no resolvable district (v_tlb_tenant_base.district_id IS NULL — the same bar tlb_children uses for its own Unmapped bucket). Corrections happen on the existing surface (correct_tenant_location / the Tenant Location Corrections hub), deep-linked from the frontend, not reimplemented here. Gated by an internal has_role check.';

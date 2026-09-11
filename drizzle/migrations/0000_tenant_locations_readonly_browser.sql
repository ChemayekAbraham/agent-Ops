-- Read-only location navigation for the parallel "Tenant Locations" test page.
-- No tenant/agent/rent/location data is written or normalised anywhere here.

CREATE OR REPLACE VIEW public.v_tlb_tenant_base
WITH (security_invoker = off) AS
WITH t AS (
  SELECT DISTINCT tenant_id FROM public.rent_requests WHERE tenant_id IS NOT NULL
)
SELECT
  p.id                                        AS tenant_id,
  COALESCE(NULLIF(TRIM(p.full_name), ''), 'Unknown') AS tenant_name,
  p.phone                                     AS tenant_phone,
  v.id   AS village_id,   v.name  AS village_name,
  pa.id  AS parish_id,    pa.name AS parish_name,
  sc.id  AS subcounty_id, sc.name AS subcounty_name,
  cy.id  AS county_id,    cy.name AS county_name,
  COALESCE(dv.id, dp.id)         AS district_id,
  COALESCE(dv.name, dp.name)     AS district_name,
  COALESCE(dv.region, dp.region) AS region,
  CASE WHEN v.id IS NOT NULL THEN 6
       WHEN COALESCE(dv.id, dp.id) IS NOT NULL THEN 2
       ELSE 0 END                AS depth,
  NULLIF(TRIM(CONCAT_WS(', ',
    NULLIF(TRIM(p.village), ''), NULLIF(TRIM(p.parish), ''),
    NULLIF(TRIM(p.sub_county), ''), NULLIF(TRIM(p.district), ''),
    NULLIF(TRIM(p.city), ''), NULLIF(TRIM(p.town), ''),
    NULLIF(TRIM(p.region), ''))), '')          AS legacy_location,
  a.agent_id,
  a.agent_name,
  a.latest_status,
  a.is_active
FROM t
JOIN public.profiles p        ON p.id = t.tenant_id
LEFT JOIN public.ug_villages v    ON v.id  = p.ug_village_id
LEFT JOIN public.ug_parishes pa   ON pa.id = v.parish_id
LEFT JOIN public.ug_subcounties sc ON sc.id = pa.subcounty_id
LEFT JOIN public.ug_counties cy   ON cy.id = sc.county_id
LEFT JOIN public.ug_districts dv  ON dv.id = cy.district_id
LEFT JOIN public.ug_districts dp  ON dp.id = p.district_id
LEFT JOIN LATERAL (
  SELECT
    COALESCE(r.assigned_agent_id, r.agent_id) AS agent_id,
    ap.full_name                              AS agent_name,
    r.status                                  AS latest_status,
    EXISTS (
      SELECT 1 FROM public.rent_requests r2
      WHERE r2.tenant_id = p.id
        AND r2.status IN ('funded', 'disbursed', 'repaying')
    ) AS is_active
  FROM public.rent_requests r
  LEFT JOIN public.profiles ap ON ap.id = COALESCE(r.assigned_agent_id, r.agent_id)
  WHERE r.tenant_id = p.id
  ORDER BY r.created_at DESC
  LIMIT 1
) a ON TRUE;

REVOKE ALL ON public.v_tlb_tenant_base FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.tlb_authorized()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_ops_role(auth.uid())
      OR public.has_role(auth.uid(), 'manager')
      OR public.has_role(auth.uid(), 'super_admin')
      OR public.has_role(auth.uid(), 'ceo')
      OR public.has_role(auth.uid(), 'coo')
      OR public.has_role(auth.uid(), 'admin');
$$;

CREATE OR REPLACE FUNCTION public.tlb_children(
  p_level text,
  p_region text DEFAULT NULL,
  p_district_id integer DEFAULT NULL,
  p_county_id integer DEFAULT NULL,
  p_subcounty_id integer DEFAULT NULL,
  p_parish_id integer DEFAULT NULL,
  p_status text DEFAULT 'all',
  p_search text DEFAULT NULL
)
RETURNS TABLE (
  node_id integer,
  label text,
  tenant_count bigint,
  leaf_count bigint,
  unmapped boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.tlb_authorized() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT b.* FROM public.v_tlb_tenant_base b
    WHERE (p_status = 'all'
           OR (p_status = 'active' AND b.is_active)
           OR (p_status = 'inactive' AND NOT b.is_active))
      AND (COALESCE(p_search, '') = ''
           OR b.tenant_name ILIKE '%' || p_search || '%'
           OR COALESCE(b.tenant_phone, '') ILIKE '%' || p_search || '%'
           OR COALESCE(b.agent_name, '') ILIKE '%' || p_search || '%')
      AND (p_region IS NULL OR b.region = p_region)
      AND (p_district_id IS NULL OR b.district_id = p_district_id)
      AND (p_county_id IS NULL OR b.county_id = p_county_id)
      AND (p_subcounty_id IS NULL OR b.subcounty_id = p_subcounty_id)
      AND (p_parish_id IS NULL OR b.parish_id = p_parish_id)
  )
  SELECT * FROM (
    -- Regions (plus the Unmapped bucket, only at the top level)
    SELECT NULL::integer, b.region, COUNT(*), 0::bigint, false
      FROM base b WHERE p_level = 'region' AND b.region IS NOT NULL
      GROUP BY b.region
    UNION ALL
    SELECT NULL::integer, 'Unmapped', COUNT(*), COUNT(*), true
      FROM base b WHERE p_level = 'region' AND b.district_id IS NULL
      GROUP BY 1
    UNION ALL
    SELECT b.district_id, b.district_name, COUNT(*),
           COUNT(*) FILTER (WHERE b.county_id IS NULL), false
      FROM base b WHERE p_level = 'district' AND b.district_id IS NOT NULL
      GROUP BY b.district_id, b.district_name
    UNION ALL
    SELECT b.county_id, b.county_name, COUNT(*), 0::bigint, false
      FROM base b WHERE p_level = 'county' AND b.county_id IS NOT NULL
      GROUP BY b.county_id, b.county_name
    UNION ALL
    SELECT b.subcounty_id, b.subcounty_name, COUNT(*), 0::bigint, false
      FROM base b WHERE p_level = 'subcounty' AND b.subcounty_id IS NOT NULL
      GROUP BY b.subcounty_id, b.subcounty_name
    UNION ALL
    SELECT b.parish_id, b.parish_name, COUNT(*), 0::bigint, false
      FROM base b WHERE p_level = 'parish' AND b.parish_id IS NOT NULL
      GROUP BY b.parish_id, b.parish_name
    UNION ALL
    SELECT b.village_id, b.village_name, COUNT(*), COUNT(*), false
      FROM base b WHERE p_level = 'village' AND b.village_id IS NOT NULL
      GROUP BY b.village_id, b.village_name
  ) q(node_id, label, tenant_count, leaf_count, unmapped)
  ORDER BY q.unmapped, q.label;
END;
$$;

CREATE OR REPLACE FUNCTION public.tlb_tenants(
  p_region text DEFAULT NULL,
  p_district_id integer DEFAULT NULL,
  p_county_id integer DEFAULT NULL,
  p_subcounty_id integer DEFAULT NULL,
  p_parish_id integer DEFAULT NULL,
  p_village_id integer DEFAULT NULL,
  p_unmapped boolean DEFAULT false,
  p_at_level text DEFAULT NULL,
  p_status text DEFAULT 'all',
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  agent_id uuid,
  agent_name text,
  latest_status text,
  is_active boolean,
  depth integer,
  region text,
  district_name text,
  county_name text,
  subcounty_name text,
  parish_name text,
  village_name text,
  legacy_location text,
  total_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.tlb_authorized() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT b.* FROM public.v_tlb_tenant_base b
    WHERE (p_status = 'all'
           OR (p_status = 'active' AND b.is_active)
           OR (p_status = 'inactive' AND NOT b.is_active))
      AND (COALESCE(p_search, '') = ''
           OR b.tenant_name ILIKE '%' || p_search || '%'
           OR COALESCE(b.tenant_phone, '') ILIKE '%' || p_search || '%'
           OR COALESCE(b.agent_name, '') ILIKE '%' || p_search || '%'
           OR COALESCE(b.district_name, '') ILIKE '%' || p_search || '%'
           OR COALESCE(b.village_name, '') ILIKE '%' || p_search || '%'
           OR COALESCE(b.parish_name, '') ILIKE '%' || p_search || '%'
           OR COALESCE(b.subcounty_name, '') ILIKE '%' || p_search || '%'
           OR COALESCE(b.county_name, '') ILIKE '%' || p_search || '%'
           OR COALESCE(b.region, '') ILIKE '%' || p_search || '%'
           OR COALESCE(b.legacy_location, '') ILIKE '%' || p_search || '%')
      AND (NOT p_unmapped OR b.district_id IS NULL)
      AND (p_region IS NULL OR b.region = p_region)
      AND (p_district_id IS NULL OR b.district_id = p_district_id)
      AND (p_county_id IS NULL OR b.county_id = p_county_id)
      AND (p_subcounty_id IS NULL OR b.subcounty_id = p_subcounty_id)
      AND (p_parish_id IS NULL OR b.parish_id = p_parish_id)
      AND (p_village_id IS NULL OR b.village_id = p_village_id)
      -- Tenants resolved only to district level stop there; they are listed at
      -- the district node instead of being pushed down a level they never had.
      AND (p_at_level IS DISTINCT FROM 'district' OR b.county_id IS NULL)
  ), counted AS (
    SELECT b.*, COUNT(*) OVER () AS total_count FROM base b
  )
  SELECT c.tenant_id, c.tenant_name, c.tenant_phone, c.agent_id, c.agent_name,
         c.latest_status, c.is_active, c.depth, c.region, c.district_name,
         c.county_name, c.subcounty_name, c.parish_name, c.village_name,
         c.legacy_location, c.total_count
  FROM counted c
  ORDER BY c.tenant_name, c.tenant_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
  OFFSET GREATEST(0, COALESCE(p_offset, 0));
END;
$$;

CREATE OR REPLACE FUNCTION public.tlb_search_locations(
  p_query text,
  p_status text DEFAULT 'all',
  p_limit integer DEFAULT 25
)
RETURNS TABLE (
  kind text,
  label text,
  path_label text,
  region text,
  district_id integer,
  county_id integer,
  subcounty_id integer,
  parish_id integer,
  village_id integer,
  tenant_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.tlb_authorized() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF COALESCE(TRIM(p_query), '') = '' THEN RETURN; END IF;

  RETURN QUERY
  WITH base AS (
    SELECT b.* FROM public.v_tlb_tenant_base b
    WHERE (p_status = 'all'
           OR (p_status = 'active' AND b.is_active)
           OR (p_status = 'inactive' AND NOT b.is_active))
      AND b.district_id IS NOT NULL
  )
  SELECT * FROM (
    SELECT 'district', b.district_name, b.region,
           b.region, b.district_id, NULL::integer, NULL::integer, NULL::integer, NULL::integer,
           COUNT(*)
      FROM base b WHERE b.district_name ILIKE '%' || p_query || '%'
      GROUP BY b.district_name, b.region, b.district_id
    UNION ALL
    SELECT 'subcounty', b.subcounty_name,
           b.county_name || ', ' || b.district_name,
           b.region, b.district_id, b.county_id, b.subcounty_id, NULL::integer, NULL::integer,
           COUNT(*)
      FROM base b WHERE b.subcounty_id IS NOT NULL
        AND b.subcounty_name ILIKE '%' || p_query || '%'
      GROUP BY b.subcounty_name, b.county_name, b.district_name, b.region,
               b.district_id, b.county_id, b.subcounty_id
    UNION ALL
    SELECT 'village', b.village_name,
           b.parish_name || ', ' || b.subcounty_name || ', ' || b.district_name,
           b.region, b.district_id, b.county_id, b.subcounty_id, b.parish_id, b.village_id,
           COUNT(*)
      FROM base b WHERE b.village_id IS NOT NULL
        AND b.village_name ILIKE '%' || p_query || '%'
      GROUP BY b.village_name, b.parish_name, b.subcounty_name, b.district_name, b.region,
               b.district_id, b.county_id, b.subcounty_id, b.parish_id, b.village_id
  ) q(kind, label, path_label, region, district_id, county_id, subcounty_id, parish_id, village_id, tenant_count)
  ORDER BY q.tenant_count DESC, q.label
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 100));
END;
$$;

REVOKE ALL ON FUNCTION public.tlb_children(text, text, integer, integer, integer, integer, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.tlb_tenants(text, integer, integer, integer, integer, integer, boolean, text, text, text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.tlb_search_locations(text, text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.tlb_children(text, text, integer, integer, integer, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tlb_tenants(text, integer, integer, integer, integer, integer, boolean, text, text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tlb_search_locations(text, text, integer) TO authenticated;
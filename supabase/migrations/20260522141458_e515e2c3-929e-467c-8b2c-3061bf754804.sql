
-- ============================================================
-- LOCATION ROLLUP — Booking.com style drill-down infrastructure
-- ============================================================

-- Materialized view: one row per (country, region, district, ward, agent, landlord)
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_house_location_rollup AS
SELECT
  COALESCE(NULLIF(TRIM(h.country),''), 'Uganda')           AS country,
  COALESCE(NULLIF(TRIM(h.region),''),   '— Unknown region —') AS region,
  COALESCE(NULLIF(TRIM(h.district),''), '— Unknown district —') AS district,
  COALESCE(NULLIF(TRIM(h.sub_county),''),'— Unknown ward —')  AS ward,
  h.agent_id,
  h.landlord_id,
  COUNT(*)::int                                             AS total,
  COUNT(*) FILTER (WHERE h.tenant_id IS NOT NULL)::int      AS occupied,
  COUNT(*) FILTER (WHERE h.tenant_id IS NULL)::int          AS vacant,
  COUNT(*) FILTER (WHERE h.is_hidden = true)::int           AS hidden,
  COALESCE(SUM(h.monthly_rent) FILTER (WHERE h.tenant_id IS NOT NULL), 0)::bigint AS revenue_ugx
FROM (
  SELECT
    id, agent_id, landlord_id, tenant_id, is_hidden, monthly_rent,
    region, district, sub_county,
    NULL::text AS country  -- placeholder until a country column is added
  FROM public.house_listings
) h
GROUP BY 1,2,3,4,5,6;

CREATE INDEX IF NOT EXISTS idx_mv_loc_rollup_country  ON public.mv_house_location_rollup (country);
CREATE INDEX IF NOT EXISTS idx_mv_loc_rollup_region   ON public.mv_house_location_rollup (country, region);
CREATE INDEX IF NOT EXISTS idx_mv_loc_rollup_district ON public.mv_house_location_rollup (country, region, district);
CREATE INDEX IF NOT EXISTS idx_mv_loc_rollup_ward     ON public.mv_house_location_rollup (country, region, district, ward);
CREATE INDEX IF NOT EXISTS idx_mv_loc_rollup_agent    ON public.mv_house_location_rollup (agent_id);
CREATE INDEX IF NOT EXISTS idx_mv_loc_rollup_landlord ON public.mv_house_location_rollup (landlord_id);

GRANT SELECT ON public.mv_house_location_rollup TO authenticated;

-- ------------------------------------------------------------
-- Refresh helper + cron
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_house_location_rollup()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW public.mv_house_location_rollup;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_house_location_rollup() TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('refresh-house-location-rollup')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-house-location-rollup');
    PERFORM cron.schedule(
      'refresh-house-location-rollup',
      '*/10 * * * *',
      $cron$ SELECT public.refresh_house_location_rollup(); $cron$
    );
  END IF;
END $$;

-- ------------------------------------------------------------
-- Drill-down RPC
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_location_breakdown(
  p_level     text,    -- 'country' | 'region' | 'district' | 'ward' | 'agent' | 'landlord'
  p_country   text DEFAULT NULL,
  p_region    text DEFAULT NULL,
  p_district  text DEFAULT NULL,
  p_ward      text DEFAULT NULL,
  p_agent_id  uuid DEFAULT NULL
)
RETURNS TABLE(
  key          text,
  label        text,
  agent_id     uuid,
  landlord_id  uuid,
  agent_name   text,
  landlord_name text,
  total        int,
  occupied     int,
  vacant       int,
  hidden       int,
  revenue_ugx  bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_level = 'country' THEN
    RETURN QUERY
    SELECT r.country, r.country, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint
    FROM mv_house_location_rollup r
    GROUP BY r.country
    ORDER BY SUM(r.total) DESC;

  ELSIF p_level = 'region' THEN
    RETURN QUERY
    SELECT r.region, r.region, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint
    FROM mv_house_location_rollup r
    WHERE r.country = p_country
    GROUP BY r.region
    ORDER BY SUM(r.total) DESC;

  ELSIF p_level = 'district' THEN
    RETURN QUERY
    SELECT r.district, r.district, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint
    FROM mv_house_location_rollup r
    WHERE r.country = p_country AND r.region = p_region
    GROUP BY r.district
    ORDER BY SUM(r.total) DESC;

  ELSIF p_level = 'ward' THEN
    RETURN QUERY
    SELECT r.ward, r.ward, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint
    FROM mv_house_location_rollup r
    WHERE r.country = p_country AND r.region = p_region AND r.district = p_district
    GROUP BY r.ward
    ORDER BY SUM(r.total) DESC;

  ELSIF p_level = 'agent' THEN
    RETURN QUERY
    SELECT r.agent_id::text, COALESCE(p.full_name, 'Unnamed agent'),
           r.agent_id, NULL::uuid, p.full_name, NULL::text,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint
    FROM mv_house_location_rollup r
    LEFT JOIN profiles p ON p.id = r.agent_id
    WHERE r.country = p_country AND r.region = p_region AND r.district = p_district AND r.ward = p_ward
    GROUP BY r.agent_id, p.full_name
    ORDER BY SUM(r.total) DESC;

  ELSIF p_level = 'landlord' THEN
    RETURN QUERY
    SELECT r.landlord_id::text, COALESCE(p.full_name, 'Unnamed landlord'),
           r.agent_id, r.landlord_id, NULL::text, p.full_name,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint
    FROM mv_house_location_rollup r
    LEFT JOIN profiles p ON p.id = r.landlord_id
    WHERE r.country = p_country AND r.region = p_region AND r.district = p_district AND r.ward = p_ward
      AND r.agent_id = p_agent_id
    GROUP BY r.landlord_id, r.agent_id, p.full_name
    ORDER BY SUM(r.total) DESC;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_location_breakdown(text,text,text,text,text,uuid) TO authenticated;

-- ------------------------------------------------------------
-- Global search RPC
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_locations(
  p_query text,
  p_limit int DEFAULT 25
)
RETURNS TABLE(
  kind     text,   -- 'country' | 'region' | 'district' | 'ward' | 'agent' | 'landlord'
  label    text,
  country  text,
  region   text,
  district text,
  ward     text,
  agent_id uuid,
  landlord_id uuid,
  total    int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q text := '%' || lower(trim(p_query)) || '%';
BEGIN
  IF p_query IS NULL OR length(trim(p_query)) < 2 THEN
    RETURN;
  END IF;

  RETURN QUERY
  -- countries
  SELECT 'country', r.country, r.country, NULL::text, NULL::text, NULL::text, NULL::uuid, NULL::uuid, SUM(r.total)::int
  FROM mv_house_location_rollup r
  WHERE lower(r.country) LIKE q
  GROUP BY r.country
  UNION ALL
  -- regions
  SELECT 'region', r.region || ', ' || r.country, r.country, r.region, NULL::text, NULL::text, NULL::uuid, NULL::uuid, SUM(r.total)::int
  FROM mv_house_location_rollup r
  WHERE lower(r.region) LIKE q
  GROUP BY r.country, r.region
  UNION ALL
  -- districts
  SELECT 'district', r.district || ', ' || r.region, r.country, r.region, r.district, NULL::text, NULL::uuid, NULL::uuid, SUM(r.total)::int
  FROM mv_house_location_rollup r
  WHERE lower(r.district) LIKE q
  GROUP BY r.country, r.region, r.district
  UNION ALL
  -- wards
  SELECT 'ward', r.ward || ', ' || r.district, r.country, r.region, r.district, r.ward, NULL::uuid, NULL::uuid, SUM(r.total)::int
  FROM mv_house_location_rollup r
  WHERE lower(r.ward) LIKE q
  GROUP BY r.country, r.region, r.district, r.ward
  UNION ALL
  -- agents
  SELECT 'agent', COALESCE(p.full_name,'Unnamed agent'), NULL::text, NULL::text, NULL::text, NULL::text, p.id, NULL::uuid, COALESCE(SUM(r.total),0)::int
  FROM profiles p
  LEFT JOIN mv_house_location_rollup r ON r.agent_id = p.id
  WHERE lower(COALESCE(p.full_name,'')) LIKE q OR lower(COALESCE(p.phone,'')) LIKE q
  GROUP BY p.id, p.full_name
  HAVING COALESCE(SUM(r.total),0) > 0
  UNION ALL
  -- landlords
  SELECT 'landlord', COALESCE(p.full_name,'Unnamed landlord'), NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid, p.id, COALESCE(SUM(r.total),0)::int
  FROM profiles p
  LEFT JOIN mv_house_location_rollup r ON r.landlord_id = p.id
  WHERE lower(COALESCE(p.full_name,'')) LIKE q OR lower(COALESCE(p.phone,'')) LIKE q
  GROUP BY p.id, p.full_name
  HAVING COALESCE(SUM(r.total),0) > 0
  ORDER BY 9 DESC NULLS LAST
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_locations(text,int) TO authenticated;

-- Seed initial population
SELECT public.refresh_house_location_rollup();

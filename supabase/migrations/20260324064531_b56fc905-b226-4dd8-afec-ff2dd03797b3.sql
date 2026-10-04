
-- Server-side spatial clustering RPC for 1M+ properties
-- Returns grid-based clusters at low zoom, individual properties at high zoom

CREATE OR REPLACE FUNCTION public.get_property_clusters(
  min_lat double precision,
  max_lat double precision,
  min_lng double precision,
  max_lng double precision,
  zoom_level integer DEFAULT 10,
  status_filter text DEFAULT NULL
)
RETURNS TABLE (
  cluster_id text,
  lat double precision,
  lng double precision,
  property_count bigint,
  empty_count bigint,
  occupied_count bigint,
  requested_count bigint,
  paid_count bigint,
  -- Only populated when returning individual properties (high zoom)
  property_id uuid,
  title text,
  address text,
  monthly_rent numeric,
  daily_rate numeric,
  house_category text,
  number_of_rooms integer,
  status text,
  tenant_id uuid,
  agent_id uuid,
  landlord_id uuid,
  image_url text,
  is_cluster boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  grid_size double precision;
  detail_zoom integer := 14;
BEGIN
  -- Grid size decreases as zoom increases (more detail)
  grid_size := 360.0 / power(2, zoom_level);

  IF zoom_level >= detail_zoom THEN
    -- High zoom: return individual properties
    RETURN QUERY
    SELECT
      h.id::text AS cluster_id,
      h.latitude AS lat,
      h.longitude AS lng,
      1::bigint AS property_count,
      CASE WHEN h.tenant_id IS NULL THEN 1 ELSE 0 END::bigint AS empty_count,
      CASE WHEN h.tenant_id IS NOT NULL THEN 1 ELSE 0 END::bigint AS occupied_count,
      0::bigint AS requested_count,
      0::bigint AS paid_count,
      h.id AS property_id,
      h.title,
      h.address,
      h.monthly_rent,
      h.daily_rate,
      h.house_category,
      h.number_of_rooms,
      h.status,
      h.tenant_id,
      h.agent_id,
      h.landlord_id,
      (h.image_urls::text[])[1] AS image_url,
      false AS is_cluster
    FROM house_listings h
    WHERE h.latitude IS NOT NULL
      AND h.longitude IS NOT NULL
      AND h.latitude BETWEEN min_lat AND max_lat
      AND h.longitude BETWEEN min_lng AND max_lng
      AND (status_filter IS NULL OR
           (status_filter = 'empty' AND h.tenant_id IS NULL) OR
           (status_filter = 'occupied' AND h.tenant_id IS NOT NULL) OR
           (status_filter IN ('requested', 'paid') AND h.tenant_id IS NOT NULL))
    LIMIT 2000;
  ELSE
    -- Low zoom: return grid clusters
    RETURN QUERY
    SELECT
      (floor(h.latitude / grid_size)::text || ':' || floor(h.longitude / grid_size)::text) AS cluster_id,
      avg(h.latitude) AS lat,
      avg(h.longitude) AS lng,
      count(*)::bigint AS property_count,
      count(*) FILTER (WHERE h.tenant_id IS NULL)::bigint AS empty_count,
      count(*) FILTER (WHERE h.tenant_id IS NOT NULL)::bigint AS occupied_count,
      0::bigint AS requested_count,
      0::bigint AS paid_count,
      NULL::uuid AS property_id,
      NULL::text AS title,
      NULL::text AS address,
      NULL::numeric AS monthly_rent,
      NULL::numeric AS daily_rate,
      NULL::text AS house_category,
      NULL::integer AS number_of_rooms,
      NULL::text AS status,
      NULL::uuid AS tenant_id,
      NULL::uuid AS agent_id,
      NULL::uuid AS landlord_id,
      NULL::text AS image_url,
      true AS is_cluster
    FROM house_listings h
    WHERE h.latitude IS NOT NULL
      AND h.longitude IS NOT NULL
      AND h.latitude BETWEEN min_lat AND max_lat
      AND h.longitude BETWEEN min_lng AND max_lng
      AND (status_filter IS NULL OR
           (status_filter = 'empty' AND h.tenant_id IS NULL) OR
           (status_filter = 'occupied' AND h.tenant_id IS NOT NULL) OR
           (status_filter IN ('requested', 'paid') AND h.tenant_id IS NOT NULL))
    GROUP BY floor(h.latitude / grid_size), floor(h.longitude / grid_size)
    ORDER BY property_count DESC
    LIMIT 500;
  END IF;
END;
$$;

-- Create index for fast bounding-box queries on lat/lng
CREATE INDEX IF NOT EXISTS idx_house_listings_lat_lng 
  ON house_listings (latitude, longitude) 
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- Index for tenant_id filtering
CREATE INDEX IF NOT EXISTS idx_house_listings_tenant_id 
  ON house_listings (tenant_id) 
  WHERE tenant_id IS NOT NULL;

-- Get total property counts by status (lightweight dashboard query)
CREATE OR REPLACE FUNCTION public.get_property_status_counts()
RETURNS TABLE (
  total_count bigint,
  empty_count bigint,
  occupied_count bigint,
  with_gps bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    count(*)::bigint AS total_count,
    count(*) FILTER (WHERE tenant_id IS NULL)::bigint AS empty_count,
    count(*) FILTER (WHERE tenant_id IS NOT NULL)::bigint AS occupied_count,
    count(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL)::bigint AS with_gps
  FROM house_listings;
$$;


-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis SCHEMA extensions;

-- Add a geography point column for spatial indexing
ALTER TABLE public.house_listings
ADD COLUMN IF NOT EXISTS geo_point geography(Point, 4326);

-- Populate geo_point from existing lat/lng
UPDATE public.house_listings
SET geo_point = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND geo_point IS NULL;

-- Create spatial index on geo_point
CREATE INDEX IF NOT EXISTS idx_house_listings_geo
ON public.house_listings USING GIST (geo_point);

-- Trigger to auto-update geo_point when lat/lng change
CREATE OR REPLACE FUNCTION public.update_house_listing_geo_point()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.geo_point := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
  ELSE
    NEW.geo_point := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_house_listing_geo_point ON public.house_listings;
CREATE TRIGGER trg_house_listing_geo_point
BEFORE INSERT OR UPDATE OF latitude, longitude ON public.house_listings
FOR EACH ROW EXECUTE FUNCTION public.update_house_listing_geo_point();

-- RPC: Find nearby available houses sorted by distance
CREATE OR REPLACE FUNCTION public.find_nearby_houses(
  user_lat DOUBLE PRECISION,
  user_lng DOUBLE PRECISION,
  radius_km DOUBLE PRECISION DEFAULT 50,
  category_filter TEXT DEFAULT NULL,
  region_filter TEXT DEFAULT NULL,
  result_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  description TEXT,
  house_category TEXT,
  number_of_rooms INTEGER,
  monthly_rent INTEGER,
  daily_rate INTEGER,
  access_fee INTEGER,
  platform_fee INTEGER,
  total_monthly_cost INTEGER,
  region TEXT,
  district TEXT,
  address TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  has_water BOOLEAN,
  has_electricity BOOLEAN,
  has_security BOOLEAN,
  has_parking BOOLEAN,
  is_furnished BOOLEAN,
  image_urls TEXT[],
  status TEXT,
  created_at TIMESTAMPTZ,
  distance_km DOUBLE PRECISION
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    h.id,
    h.title,
    h.description,
    h.house_category,
    h.number_of_rooms,
    h.monthly_rent,
    h.daily_rate,
    h.access_fee,
    h.platform_fee,
    h.total_monthly_cost,
    h.region,
    h.district,
    h.address,
    h.latitude,
    h.longitude,
    h.has_water,
    h.has_electricity,
    h.has_security,
    h.has_parking,
    h.is_furnished,
    h.image_urls,
    h.status,
    h.created_at,
    ROUND((ST_Distance(
      h.geo_point,
      ST_SetSRID(ST_MakePoint(user_lng, user_lat), 4326)::geography
    ) / 1000.0)::numeric, 2)::double precision AS distance_km
  FROM public.house_listings h
  WHERE h.status = 'available'
    AND (category_filter IS NULL OR h.house_category = category_filter)
    AND (region_filter IS NULL OR h.region ILIKE '%' || region_filter || '%')
    AND (
      h.geo_point IS NULL
      OR ST_DWithin(
        h.geo_point,
        ST_SetSRID(ST_MakePoint(user_lng, user_lat), 4326)::geography,
        radius_km * 1000
      )
    )
  ORDER BY
    CASE WHEN h.geo_point IS NOT NULL THEN 0 ELSE 1 END,
    ST_Distance(
      COALESCE(h.geo_point, ST_SetSRID(ST_MakePoint(user_lng, user_lat), 4326)::geography),
      ST_SetSRID(ST_MakePoint(user_lng, user_lat), 4326)::geography
    ),
    h.created_at DESC
  LIMIT result_limit;
END;
$$;

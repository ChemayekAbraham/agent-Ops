
DROP FUNCTION IF EXISTS public.find_nearby_houses(double precision, double precision, double precision, text, text, integer);

CREATE FUNCTION public.find_nearby_houses(
  user_lat double precision,
  user_lng double precision,
  radius_km double precision DEFAULT 50,
  category_filter text DEFAULT NULL,
  region_filter text DEFAULT NULL,
  result_limit integer DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  title text,
  description text,
  house_category text,
  number_of_rooms integer,
  monthly_rent numeric,
  daily_rate numeric,
  access_fee numeric,
  platform_fee numeric,
  total_monthly_cost numeric,
  region text,
  district text,
  address text,
  latitude double precision,
  longitude double precision,
  has_water boolean,
  has_electricity boolean,
  has_security boolean,
  has_parking boolean,
  is_furnished boolean,
  image_urls text[],
  status text,
  verified boolean,
  created_at timestamptz,
  distance_km double precision
)
LANGUAGE plpgsql
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
    h.verified,
    h.created_at,
    ROUND((ST_Distance(
      h.geo_point,
      ST_SetSRID(ST_MakePoint(user_lng, user_lat), 4326)::geography
    ) / 1000.0)::numeric, 2)::double precision AS distance_km
  FROM public.house_listings h
  WHERE h.status IN ('available', 'pending')
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

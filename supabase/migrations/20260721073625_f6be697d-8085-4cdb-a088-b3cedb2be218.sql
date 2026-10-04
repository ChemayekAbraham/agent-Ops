DROP FUNCTION IF EXISTS public.search_landlords_fuzzy(text, integer, real);

CREATE OR REPLACE FUNCTION public.search_landlords_fuzzy(
  p_query text DEFAULT '',
  p_limit integer DEFAULT 20,
  p_threshold real DEFAULT 0.2
)
RETURNS TABLE(
  id uuid, name text, phone text, property_address text,
  district text, town_council text, county text, village text,
  house_category text, monthly_rent numeric,
  latitude numeric, longitude numeric,
  verified boolean,
  match_score real, match_kind text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH q AS (
    SELECT
      trim(coalesce(p_query, '')) AS raw,
      lower(trim(coalesce(p_query, ''))) AS lc,
      regexp_replace(coalesce(p_query, ''), '\D', '', 'g') AS digits
  ),
  base AS (
    SELECT l.*,
      CASE
        WHEN (SELECT raw FROM q) = '' THEN 1.0
        WHEN lower(l.name) = (SELECT lc FROM q) THEN 1.0
        WHEN (SELECT digits FROM q) <> '' AND l.phone ILIKE '%' || (SELECT digits FROM q) || '%' THEN 0.95
        WHEN l.name ILIKE '%' || (SELECT raw FROM q) || '%' THEN 0.9
        ELSE similarity(lower(l.name), (SELECT lc FROM q))
      END::real AS score,
      CASE
        WHEN (SELECT raw FROM q) = '' THEN 'all'
        WHEN lower(l.name) = (SELECT lc FROM q) THEN 'name_exact'
        WHEN (SELECT digits FROM q) <> '' AND l.phone ILIKE '%' || (SELECT digits FROM q) || '%' THEN 'phone'
        WHEN l.name ILIKE '%' || (SELECT raw FROM q) || '%' THEN 'name_exact'
        ELSE 'fuzzy'
      END AS kind
    FROM public.landlords_directory l
    WHERE COALESCE(l.verified, false) = true
  )
  SELECT b.id, b.name, b.phone, b.property_address,
    b.district, b.town_council, b.county, b.village,
    b.house_category, b.monthly_rent, b.latitude, b.longitude,
    COALESCE(b.verified, false) AS verified,
    b.score AS match_score, b.kind AS match_kind
  FROM base b
  WHERE (SELECT raw FROM q) = '' OR b.score >= p_threshold
  ORDER BY b.score DESC, b.name ASC
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;

GRANT EXECUTE ON FUNCTION public.search_landlords_fuzzy(text, integer, real) TO authenticated, service_role;
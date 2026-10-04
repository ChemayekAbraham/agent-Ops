CREATE OR REPLACE FUNCTION public.ug_search_villages(
  p_query text,
  p_limit integer DEFAULT 20,
  p_district_id integer DEFAULT NULL,
  p_district_name text DEFAULT NULL
)
RETURNS TABLE (
  village_id integer, village_name text,
  parish_id integer, parish_name text,
  subcounty_id integer, subcounty_name text,
  county_id integer, county_name text,
  district_id integer, district_name text,
  full_path text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT v.id, v.name,
         p.id, p.name,
         s.id, s.name,
         c.id, c.name,
         d.id, d.name,
         v.name || ', ' || p.name || ', ' || s.name || ', ' || c.name || ', ' || d.name
  FROM ug_villages v
  JOIN ug_parishes p ON p.id = v.parish_id
  JOIN ug_subcounties s ON s.id = p.subcounty_id
  JOIN ug_counties c ON c.id = s.county_id
  JOIN ug_districts d ON d.id = c.district_id
  WHERE lower(v.name) LIKE '%' || lower(trim(coalesce(p_query, ''))) || '%'
    AND (p_district_id IS NULL OR d.id = p_district_id)
    AND (p_district_name IS NULL OR trim(p_district_name) = '' OR lower(d.name) = lower(trim(p_district_name)))
  ORDER BY (lower(v.name) = lower(trim(coalesce(p_query, '')))) DESC,
           length(v.name), v.name
  LIMIT LEAST(coalesce(p_limit, 20), 50);
$$;

GRANT EXECUTE ON FUNCTION public.ug_search_villages(text, integer, integer, text) TO anon, authenticated;
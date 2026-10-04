CREATE OR REPLACE FUNCTION public.get_house_listing_filter_options(
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_subcounty text DEFAULT NULL
)
RETURNS TABLE(kind text, value text, n bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT h.region, h.district, h.sub_county, h.village, h.house_category
    FROM public.house_listings h
    WHERE h.status = 'available'
      AND h.is_hidden = false
      AND h.image_urls IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM unnest(h.image_urls) u WHERE btrim(coalesce(u, '')) <> ''
      )
  ),
  scoped AS (
    SELECT * FROM base b
    WHERE (p_region IS NULL OR lower(btrim(b.region)) = lower(btrim(p_region)))
      AND (p_district IS NULL OR lower(btrim(coalesce(b.district, ''))) = lower(btrim(p_district)))
      AND (p_subcounty IS NULL OR lower(btrim(coalesce(b.sub_county, ''))) = lower(btrim(p_subcounty)))
  )
  -- Regions come from the fixed official set present in the data.
  SELECT 'region', btrim(b.region), count(*)
  FROM base b WHERE btrim(coalesce(b.region, '')) <> '' GROUP BY 2
  UNION ALL
  -- Areas are validated against the official ug_* dataset so free-text typos in
  -- legacy listings never become filter options. Case folding merges duplicates.
  SELECT 'district', u.name, count(*)
  FROM scoped s
  JOIN public.ug_districts u ON lower(u.name) = lower(btrim(coalesce(s.district, '')))
  GROUP BY 2
  UNION ALL
  SELECT 'subcounty', u.name, count(*)
  FROM scoped s
  JOIN (SELECT DISTINCT name FROM public.ug_subcounties) u
    ON lower(u.name) = lower(btrim(coalesce(s.sub_county, '')))
  GROUP BY 2
  UNION ALL
  SELECT 'village', u.name, count(*)
  FROM scoped s
  JOIN (SELECT DISTINCT name FROM public.ug_villages) u
    ON lower(u.name) = lower(btrim(coalesce(s.village, '')))
  GROUP BY 2
  UNION ALL
  SELECT 'category', s.house_category, count(*)
  FROM scoped s WHERE btrim(coalesce(s.house_category, '')) <> '' GROUP BY 2
$$;
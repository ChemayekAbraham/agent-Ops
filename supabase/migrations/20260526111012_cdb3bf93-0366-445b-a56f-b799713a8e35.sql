CREATE OR REPLACE FUNCTION public.normalize_uganda_region(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_raw IS NULL OR btrim(p_raw) = '' THEN NULL
    WHEN lower(btrim(regexp_replace(p_raw, '\s+region$', '', 'i'))) IN ('central','eastern','northern','western')
      THEN initcap(lower(btrim(regexp_replace(p_raw, '\s+region$', '', 'i'))))
    WHEN lower(btrim(p_raw)) IN (
      'kampala','wakiso','mukono','mpigi','masaka','entebbe','nansana','kira',
      'bweyogerere','kyengera','luwero','mityana','mubende','nakasongola','kayunga',
      'buikwe','butambala','gomba','kalangala','kyankwanzi','lwengo','lyantonde',
      'rakai','sembabule'
    ) THEN 'Central'
    WHEN lower(btrim(p_raw)) IN (
      'jinja','mbale','soroti','iganga','tororo','busia','kapchorwa','pallisa'
    ) THEN 'Eastern'
    WHEN lower(btrim(p_raw)) IN (
      'gulu','lira','arua','kitgum','pader','moyo','nebbi','adjumani'
    ) THEN 'Northern'
    WHEN lower(btrim(p_raw)) IN (
      'mbarara','kabale','kasese','hoima','fort portal','kabarole','bushenyi',
      'ntungamo','rukungiri','kanungu','ibanda'
    ) THEN 'Western'
    ELSE btrim(p_raw)
  END;
$$;

CREATE OR REPLACE FUNCTION public.normalize_uganda_district(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_raw IS NULL OR btrim(p_raw) = '' THEN NULL
    WHEN lower(btrim(p_raw)) IN ('entebbe','nansana','kira','bweyogerere','kyengera') THEN 'Wakiso'
    ELSE initcap(lower(btrim(p_raw)))
  END;
$$;

CREATE TABLE IF NOT EXISTS public.house_listings_region_normalization_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  house_id uuid NOT NULL,
  old_region text,
  old_district text,
  new_region text,
  new_district text,
  run_at timestamptz NOT NULL DEFAULT now()
);

WITH candidates AS (
  SELECT
    id,
    region   AS old_region,
    district AS old_district,
    public.normalize_uganda_region(COALESCE(NULLIF(btrim(region),''), district)) AS new_region,
    COALESCE(
      NULLIF(btrim(district), ''),
      public.normalize_uganda_district(region)
    ) AS new_district
  FROM public.house_listings
  WHERE region IS NOT NULL
)
INSERT INTO public.house_listings_region_normalization_log
  (house_id, old_region, old_district, new_region, new_district)
SELECT id, old_region, old_district, new_region, new_district
FROM candidates
WHERE (new_region IS DISTINCT FROM old_region)
   OR (new_district IS DISTINCT FROM old_district);

UPDATE public.house_listings h
SET region = c.new_region, district = c.new_district
FROM (
  SELECT
    id,
    public.normalize_uganda_region(COALESCE(NULLIF(btrim(region),''), district)) AS new_region,
    COALESCE(
      NULLIF(btrim(district), ''),
      public.normalize_uganda_district(region)
    ) AS new_district
  FROM public.house_listings
  WHERE region IS NOT NULL
) c
WHERE h.id = c.id
  AND ((h.region IS DISTINCT FROM c.new_region)
    OR (h.district IS DISTINCT FROM c.new_district));

INSERT INTO public.system_events (event_type, related_entity_type, related_entity_id, metadata)
SELECT
  'house_listings.region_normalized'::public.system_event_type,
  'house_listing',
  house_id,
  jsonb_build_object(
    'old_region',   old_region,
    'old_district', old_district,
    'new_region',   new_region,
    'new_district', new_district
  )
FROM public.house_listings_region_normalization_log
WHERE run_at >= now() - interval '5 minutes';
UPDATE public.house_listings
SET district = initcap(lower(btrim(regexp_replace(district, '\s+district$', '', 'i'))))
WHERE district IS NOT NULL
  AND district IS DISTINCT FROM initcap(lower(btrim(regexp_replace(district, '\s+district$', '', 'i'))));
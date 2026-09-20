-- Adds an optional listing-age filter to the viewport clustering function so
-- funders can focus the Africa-wide heatmap on freshly listed empty houses.
-- The old signature is replaced by one extra trailing parameter with a default.
DROP FUNCTION IF EXISTS public.map_empty_house_cells(double precision, double precision, double precision, double precision, integer, text, text, numeric, numeric, integer);

CREATE OR REPLACE FUNCTION public.map_empty_house_cells(
  p_min_lat double precision,
  p_min_lng double precision,
  p_max_lat double precision,
  p_max_lng double precision,
  p_zoom integer DEFAULT 11,
  p_search text DEFAULT NULL::text,
  p_district text DEFAULT NULL::text,
  p_min_rent numeric DEFAULT NULL::numeric,
  p_max_rent numeric DEFAULT NULL::numeric,
  p_limit integer DEFAULT 400,
  p_max_age_days integer DEFAULT NULL::integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_zoom integer := LEAST(GREATEST(COALESCE(p_zoom, 11), 1), 20);
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 400), 1), 1000);
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_district text := NULLIF(btrim(COALESCE(p_district, '')), '');
  v_age_days integer := CASE
    WHEN p_max_age_days IS NULL THEN NULL
    ELSE LEAST(GREATEST(p_max_age_days, 1), 3650)
  END;
  v_listed_after timestamptz := CASE
    WHEN v_age_days IS NULL THEN NULL
    ELSE now() - make_interval(days => v_age_days)
  END;
  v_scan_cap integer := 20000;
  v_cell double precision;
  v_min_lat double precision := LEAST(p_min_lat, p_max_lat);
  v_max_lat double precision := GREATEST(p_min_lat, p_max_lat);
  v_min_lng double precision := LEAST(p_min_lng, p_max_lng);
  v_max_lng double precision := GREATEST(p_min_lng, p_max_lng);
  v_cells jsonb := '[]'::jsonb;
  v_scanned integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT (
    public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
    OR public.has_role(v_uid, 'sub_agent') OR public.has_role(v_uid, 'supporter')
    OR public.is_ops_role(v_uid)
  ) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  IF p_min_lat IS NULL OR p_min_lng IS NULL OR p_max_lat IS NULL OR p_max_lng IS NULL THEN
    RETURN jsonb_build_object('cells', '[]'::jsonb, 'zoom', v_zoom, 'cell_size', 0,
                              'scanned', 0, 'scan_capped', false);
  END IF;

  -- Grid pitch halves with every zoom step: ~2.4 km at z11, ~150 m at z15,
  -- ~20 m at z18, so zoomed-in cells hold a single house.
  v_cell := 360.0 / power(2, v_zoom + 3);

  WITH base AS (
    SELECT
      h.id, h.latitude, h.longitude,
      COALESCE(h.monthly_rent, 0)::numeric AS rent,
      h.title, h.house_category, h.district, h.sub_county, h.village,
      h.verified, h.image_urls, h.created_at
    FROM public.house_listings h
    WHERE h.status = 'available'
      AND h.tenant_id IS NULL
      AND COALESCE(h.is_hidden, false) = false
      AND COALESCE(h.monthly_rent, 0) > 0
      AND h.geo_point IS NOT NULL
      AND ST_Intersects(
            h.geo_point,
            ST_MakeEnvelope(v_min_lng, v_min_lat, v_max_lng, v_max_lat, 4326)::geography
          )
      AND (v_district IS NULL OR h.district ILIKE v_district)
      AND (p_min_rent IS NULL OR COALESCE(h.monthly_rent, 0) >= p_min_rent)
      AND (p_max_rent IS NULL OR COALESCE(h.monthly_rent, 0) <= p_max_rent)
      AND (v_listed_after IS NULL OR h.created_at >= v_listed_after)
      AND (
        v_search IS NULL
        OR h.title ILIKE '%' || v_search || '%'
        OR h.district ILIKE '%' || v_search || '%'
        OR h.sub_county ILIKE '%' || v_search || '%'
        OR h.village ILIKE '%' || v_search || '%'
        OR h.region ILIKE '%' || v_search || '%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.promissory_note_house_intents i
        WHERE i.house_id = h.id AND i.status = 'reserved'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.partner_supported_houses psh
        WHERE psh.house_id = h.id AND psh.status IN ('pending', 'active')
      )
    LIMIT v_scan_cap
  ),
  cells AS (
    SELECT
      floor(b.latitude / v_cell)::bigint AS gy,
      floor(b.longitude / v_cell)::bigint AS gx,
      COUNT(*)::bigint AS c,
      avg(b.latitude) AS lat,
      avg(b.longitude) AS lng,
      min(b.rent) AS min_rent,
      max(b.rent) AS max_rent,
      (array_agg(
        jsonb_build_object(
          'house_id', b.id,
          'title', b.title,
          'house_category', b.house_category,
          'district', b.district,
          'sub_county', b.sub_county,
          'village', b.village,
          'monthly_rent', b.rent,
          'latitude', b.latitude,
          'longitude', b.longitude,
          'verified', b.verified,
          'image_urls', COALESCE(to_jsonb(b.image_urls), '[]'::jsonb),
          'created_at', b.created_at
        ) ORDER BY b.rent ASC, b.id
      ))[1] AS sample
    FROM base b
    GROUP BY 1, 2
  ),
  scanned AS (SELECT COALESCE(SUM(c), 0)::integer AS n FROM cells)
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'key', c.gx::text || ':' || c.gy::text,
          'count', c.c,
          'latitude', CASE WHEN c.c = 1 THEN (c.sample->>'latitude')::double precision ELSE c.lat END,
          'longitude', CASE WHEN c.c = 1 THEN (c.sample->>'longitude')::double precision ELSE c.lng END,
          'min_rent', c.min_rent,
          'max_rent', c.max_rent,
          'house', CASE WHEN c.c = 1 THEN c.sample ELSE NULL END
        )
        ORDER BY c.c DESC
      ),
      '[]'::jsonb
    ),
    (SELECT n FROM scanned)
  INTO v_cells, v_scanned
  FROM (SELECT * FROM cells ORDER BY c DESC LIMIT v_limit) c;

  RETURN jsonb_build_object(
    'cells', v_cells,
    'zoom', v_zoom,
    'cell_size', v_cell,
    'scanned', v_scanned,
    'scan_capped', v_scanned >= v_scan_cap
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.map_empty_house_cells(double precision, double precision, double precision, double precision, integer, text, text, numeric, numeric, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.map_empty_house_cells(double precision, double precision, double precision, double precision, integer, text, text, numeric, numeric, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.map_empty_house_cells(double precision, double precision, double precision, double precision, integer, text, text, numeric, numeric, integer, integer) TO service_role;
CREATE OR REPLACE FUNCTION public.agent_list_empty_house_opportunities(
  p_search text DEFAULT NULL::text,
  p_limit integer DEFAULT 30,
  p_offset integer DEFAULT 0,
  p_district text DEFAULT NULL::text,
  p_verified_only boolean DEFAULT false,
  p_gps_only boolean DEFAULT false,
  p_min_rent numeric DEFAULT NULL::numeric,
  p_max_rent numeric DEFAULT NULL::numeric,
  p_near_lat double precision DEFAULT NULL::double precision,
  p_near_lng double precision DEFAULT NULL::double precision,
  p_radius_km double precision DEFAULT NULL::double precision,
  p_sort text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_district text := NULLIF(btrim(COALESCE(p_district, '')), '');
  v_radius double precision := NULLIF(COALESCE(p_radius_km, 0), 0);
  v_sort text := lower(NULLIF(btrim(COALESCE(p_sort, '')), ''));
  v_dlat double precision;
  v_dlng double precision;
  v_total bigint := 0;
  v_rows jsonb := '[]'::jsonb;
  v_districts jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF NOT (
    public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
    OR public.has_role(v_uid, 'sub_agent') OR public.has_role(v_uid, 'supporter')
    OR public.is_ops_role(v_uid)
  ) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  IF v_sort IS NULL OR v_sort NOT IN ('recommended', 'nearest', 'newest', 'rent_high', 'rent_low') THEN
    v_sort := 'recommended';
  END IF;

  IF v_sort = 'nearest' AND (p_near_lat IS NULL OR p_near_lng IS NULL) THEN
    v_sort := 'recommended';
  END IF;

  IF v_radius IS NOT NULL AND p_near_lat IS NOT NULL AND p_near_lng IS NOT NULL THEN
    v_dlat := v_radius / 111.0;
    v_dlng := v_radius / GREATEST(cos(radians(p_near_lat)) * 111.0, 0.000001);
  END IF;

  WITH base AS (
    SELECT
      h.id,
      h.verified,
      h.created_at,
      COALESCE(h.monthly_rent, 0) AS monthly_rent,
      CASE
        WHEN p_near_lat IS NULL OR p_near_lng IS NULL
          OR h.latitude IS NULL OR h.longitude IS NULL THEN NULL
        ELSE sqrt(
          pow((h.latitude - p_near_lat) * 111.0, 2)
          + pow((h.longitude - p_near_lng) * cos(radians(p_near_lat)) * 111.0, 2)
        )
      END AS distance_km
    FROM public.house_listings h
    LEFT JOIN public.profiles lp ON lp.id = h.landlord_id
    LEFT JOIN public.profiles ap ON ap.id = h.agent_id
    WHERE h.status = 'available'
      AND h.tenant_id IS NULL
      AND COALESCE(h.is_hidden, false) = false
      AND COALESCE(h.monthly_rent, 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.promissory_note_house_intents i
        WHERE i.house_id = h.id AND i.status = 'reserved'
      )
      AND (
        v_search IS NULL
        OR h.title ILIKE '%' || v_search || '%'
        OR h.district ILIKE '%' || v_search || '%'
        OR h.sub_county ILIKE '%' || v_search || '%'
        OR h.village ILIKE '%' || v_search || '%'
        OR h.region ILIKE '%' || v_search || '%'
        OR lp.full_name ILIKE '%' || v_search || '%'
        OR lp.phone ILIKE '%' || v_search || '%'
        OR ap.full_name ILIKE '%' || v_search || '%'
      )
      AND (v_district IS NULL OR h.district ILIKE v_district)
      AND (COALESCE(p_verified_only, false) = false OR COALESCE(h.verified, false) = true)
      AND (
        COALESCE(p_gps_only, false) = false
        OR (h.latitude IS NOT NULL AND h.longitude IS NOT NULL AND (h.latitude <> 0 OR h.longitude <> 0))
      )
      AND (p_min_rent IS NULL OR COALESCE(h.monthly_rent, 0) >= p_min_rent)
      AND (p_max_rent IS NULL OR COALESCE(h.monthly_rent, 0) <= p_max_rent)
      AND (
        v_dlat IS NULL
        OR (
          h.latitude IS NOT NULL AND h.longitude IS NOT NULL
          AND h.latitude BETWEEN p_near_lat - v_dlat AND p_near_lat + v_dlat
          AND h.longitude BETWEEN p_near_lng - v_dlng AND p_near_lng + v_dlng
        )
      )
  ),
  counted AS (SELECT COUNT(*) AS c FROM base),
  page AS (
    SELECT
      b.id,
      b.distance_km,
      row_number() OVER (
        ORDER BY
          CASE WHEN v_sort = 'nearest' THEN b.distance_km END ASC NULLS LAST,
          CASE WHEN v_sort = 'newest' THEN b.created_at END DESC NULLS LAST,
          CASE WHEN v_sort = 'rent_high' THEN b.monthly_rent END DESC NULLS LAST,
          CASE WHEN v_sort = 'rent_low' THEN b.monthly_rent END ASC NULLS LAST,
          CASE WHEN v_sort = 'recommended' THEN (CASE WHEN b.verified THEN 0 ELSE 1 END) END ASC NULLS LAST,
          b.created_at DESC
      ) AS rn
    FROM base b
    ORDER BY rn
    LIMIT v_limit OFFSET v_offset
  ),
  rows_json AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'house_id', h.id,
      'title', h.title,
      'house_category', h.house_category,
      'monthly_rent', COALESCE(h.monthly_rent, 0),
      'district', h.district,
      'sub_county', h.sub_county,
      'village', h.village,
      'region', h.region,
      'number_of_rooms', h.number_of_rooms,
      'verified', COALESCE(h.verified, false),
      'listing_agent_id', h.agent_id,
      'listing_agent_name', p.full_name,
      'image_url', CASE WHEN h.image_urls IS NOT NULL AND array_length(h.image_urls, 1) > 0 THEN h.image_urls[1] ELSE NULL END,
      'image_urls', COALESCE(to_jsonb(h.image_urls), '[]'::jsonb),
      'latitude', h.latitude,
      'longitude', h.longitude,
      'landlord_id', h.landlord_id,
      'landlord_name', lp.full_name,
      'landlord_phone', lp.phone,
      'distance_km', pg.distance_km,
      'partner_monthly_return', round(COALESCE(h.monthly_rent, 0) * 0.15),
      'partner_annual_return', round(COALESCE(h.monthly_rent, 0) * 0.15 * 12),
      'created_at', h.created_at
    ) ORDER BY pg.rn), '[]'::jsonb) AS j
    FROM page pg
    JOIN public.house_listings h ON h.id = pg.id
    LEFT JOIN public.profiles p ON p.id = h.agent_id
    LEFT JOIN public.profiles lp ON lp.id = h.landlord_id
  )
  SELECT counted.c, rows_json.j INTO v_total, v_rows FROM counted, rows_json;

  SELECT COALESCE(jsonb_agg(q.d ORDER BY q.d), '[]'::jsonb) INTO v_districts
  FROM (
    SELECT DISTINCT btrim(hl.district) AS d
    FROM public.house_listings hl
    WHERE hl.status = 'available'
      AND hl.tenant_id IS NULL
      AND COALESCE(hl.is_hidden, false) = false
      AND COALESCE(hl.monthly_rent, 0) > 0
      AND NULLIF(btrim(COALESCE(hl.district, '')), '') IS NOT NULL
  ) q;

  RETURN jsonb_build_object('total', v_total, 'houses', v_rows, 'districts', v_districts, 'sort', v_sort);
END;
$function$;
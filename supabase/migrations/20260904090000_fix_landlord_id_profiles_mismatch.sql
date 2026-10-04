-- Fix: house_listings.landlord_id / rent_requests.landlord_id / etc. reference
-- public.landlords.id, NEVER public.profiles.id (verified empirically against
-- production: 0 matches to profiles across every landlord_id-bearing table
-- except two unrelated 2-3-row outliers). A number of functions were joining
-- `profiles` instead of `landlords` to resolve landlord name/phone, so the
-- join always produced NULL (or, for INNER JOINs, silently dropped all rows).
-- This surfaced as "Name not on file / No contact on file" for every landlord
-- in the agent Empty House browse screen, an always-empty landlord leaderboard
-- on the Capital Opportunities dashboard, and a landlord search box that never
-- returned a single result.
--
-- Fix is mechanical per function: swap the landlord-identity join from
-- `profiles <alias>` to `landlords <alias>`, and `<alias>.full_name` ->
-- `<alias>.name` (landlords has no full_name column). No other logic touched.

CREATE OR REPLACE FUNCTION public.agent_list_empty_house_opportunities(p_search text DEFAULT NULL::text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0, p_district text DEFAULT NULL::text, p_verified_only boolean DEFAULT false, p_gps_only boolean DEFAULT false, p_min_rent numeric DEFAULT NULL::numeric, p_max_rent numeric DEFAULT NULL::numeric, p_near_lat double precision DEFAULT NULL::double precision, p_near_lng double precision DEFAULT NULL::double precision, p_radius_km double precision DEFAULT NULL::double precision, p_sort text DEFAULT NULL::text)
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
    LEFT JOIN public.landlords lp ON lp.id = h.landlord_id
    LEFT JOIN public.profiles ap ON ap.id = h.agent_id
    WHERE h.status = 'available'
      AND h.tenant_id IS NULL
      AND COALESCE(h.is_hidden, false) = false
      AND COALESCE(h.monthly_rent, 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.promissory_note_house_intents i
        WHERE i.house_id = h.id AND i.status = 'reserved'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.partner_supported_houses psh
        WHERE psh.house_id = h.id
          AND psh.status IN ('pending', 'active')
      )
      AND (
        v_search IS NULL
        OR h.title ILIKE '%' || v_search || '%'
        OR h.district ILIKE '%' || v_search || '%'
        OR h.sub_county ILIKE '%' || v_search || '%'
        OR h.village ILIKE '%' || v_search || '%'
        OR h.region ILIKE '%' || v_search || '%'
        OR lp.name ILIKE '%' || v_search || '%'
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
      'landlord_name', lp.name,
      'landlord_phone', lp.phone,
      'distance_km', pg.distance_km,
      'partner_monthly_return', round(COALESCE(h.monthly_rent, 0) * 0.15),
      'partner_annual_return', round(COALESCE(h.monthly_rent, 0) * 0.15 * 12),
      'created_at', h.created_at
    ) ORDER BY pg.rn), '[]'::jsonb) AS j
    FROM page pg
    JOIN public.house_listings h ON h.id = pg.id
    LEFT JOIN public.profiles p ON p.id = h.agent_id
    LEFT JOIN public.landlords lp ON lp.id = h.landlord_id
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
      AND NOT EXISTS (
        SELECT 1 FROM public.partner_supported_houses psh
        WHERE psh.house_id = hl.id
          AND psh.status IN ('pending', 'active')
      )
  ) q;

  RETURN jsonb_build_object('total', v_total, 'houses', v_rows, 'districts', v_districts);
END;
$function$;

CREATE OR REPLACE FUNCTION public.empty_house_opportunity_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH base AS (
  SELECT h.id, COALESCE(h.monthly_rent, 0) AS rent,
         NULLIF(TRIM(COALESCE(h.district, '')), '') AS district,
         h.landlord_id,
         EXISTS (
           SELECT 1 FROM public.promissory_note_house_intents i
           WHERE i.house_id = h.id AND i.status = 'reserved'
         ) AS is_funded
  FROM public.house_listings h
  WHERE h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden, false) = false
    AND COALESCE(h.monthly_rent, 0) > 0
),
avail AS (SELECT * FROM base WHERE NOT is_funded),
districts AS (
  SELECT jsonb_agg(d ORDER BY (d->>'total_rent_needed')::numeric DESC) AS rows
  FROM (
    SELECT jsonb_build_object(
      'district', COALESCE(district, 'Unspecified'),
      'house_count', COUNT(*),
      'total_rent_needed', COALESCE(SUM(rent), 0),
      'monthly_return', COALESCE(SUM(ROUND(rent * 0.15)), 0)
    ) AS d
    FROM avail
    GROUP BY COALESCE(district, 'Unspecified')
    ORDER BY SUM(rent) DESC
    LIMIT 12
  ) t
),
landlords AS (
  SELECT jsonb_agg(l ORDER BY (l->>'total_rent_needed')::numeric DESC) AS rows
  FROM (
    SELECT jsonb_build_object(
      'landlord_name', TRIM(p.name),
      'house_count', COUNT(*),
      'total_rent_needed', COALESCE(SUM(a.rent), 0),
      'monthly_return', COALESCE(SUM(ROUND(a.rent * 0.15)), 0)
    ) AS l
    FROM avail a
    JOIN public.landlords p ON p.id = a.landlord_id
    WHERE NULLIF(TRIM(COALESCE(p.name, '')), '') IS NOT NULL
    GROUP BY TRIM(p.name)
    ORDER BY SUM(a.rent) DESC
    LIMIT 8
  ) t
)
SELECT jsonb_build_object(
  'house_count', (SELECT COUNT(*) FROM avail),
  'total_rent_needed', (SELECT COALESCE(SUM(rent), 0) FROM avail),
  'monthly_return_if_all_funded', (SELECT COALESCE(SUM(ROUND(rent * 0.15)), 0) FROM avail),
  'avg_monthly_rent', (SELECT COALESCE(ROUND(AVG(rent)), 0) FROM avail),
  'funded_count', (SELECT COUNT(*) FROM base WHERE is_funded),
  'funded_rent', (SELECT COALESCE(SUM(rent), 0) FROM base WHERE is_funded),
  'total_listed', (SELECT COUNT(*) FROM base),
  'districts', COALESCE((SELECT rows FROM districts), '[]'::jsonb),
  'landlords', COALESCE((SELECT rows FROM landlords), '[]'::jsonb)
);
$function$;

CREATE OR REPLACE FUNCTION public.get_location_breakdown(p_level text, p_country text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_district text DEFAULT NULL::text, p_ward text DEFAULT NULL::text, p_agent_id uuid DEFAULT NULL::uuid, p_district_id integer DEFAULT NULL::integer, p_subcounty_id integer DEFAULT NULL::integer)
 RETURNS TABLE(key text, label text, agent_id uuid, landlord_id uuid, agent_name text, landlord_name text, total integer, occupied integer, vacant integer, hidden integer, revenue_ugx bigint, district_id integer, subcounty_id integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_level = 'country' THEN
    RETURN QUERY
    SELECT r.country, r.country, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint,
           NULL::int, NULL::int
    FROM mv_house_location_rollup r
    GROUP BY r.country
    ORDER BY SUM(r.total) DESC;

  ELSIF p_level = 'region' THEN
    RETURN QUERY
    SELECT r.region, r.region, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint,
           NULL::int, NULL::int
    FROM mv_house_location_rollup r
    WHERE r.country = p_country
    GROUP BY r.region
    ORDER BY SUM(r.total) DESC;

  ELSIF p_level = 'district' THEN
    RETURN QUERY
    SELECT r.district, r.district, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint,
           MAX(r.district_id)::int, NULL::int
    FROM mv_house_location_rollup r
    WHERE r.country = p_country AND r.region = p_region
    GROUP BY r.district
    ORDER BY SUM(r.total) DESC;

  ELSIF p_level = 'ward' THEN
    RETURN QUERY
    SELECT r.ward, r.ward, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint,
           MAX(r.district_id)::int, MAX(r.subcounty_id)::int
    FROM mv_house_location_rollup r
    WHERE r.country = p_country
      AND (p_district_id IS NOT NULL AND r.district_id = p_district_id
           OR p_district_id IS NULL AND r.region = p_region AND r.district = p_district)
    GROUP BY r.ward
    ORDER BY SUM(r.total) DESC;

  ELSIF p_level = 'agent' THEN
    RETURN QUERY
    SELECT r.agent_id::text, COALESCE(p.full_name, 'Unnamed agent'),
           r.agent_id, NULL::uuid, p.full_name, NULL::text,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint,
           MAX(r.district_id)::int, MAX(r.subcounty_id)::int
    FROM mv_house_location_rollup r
    LEFT JOIN profiles p ON p.id = r.agent_id
    WHERE r.country = p_country
      AND (p_district_id IS NOT NULL AND r.district_id = p_district_id
           OR p_district_id IS NULL AND r.region = p_region AND r.district = p_district)
      AND (p_subcounty_id IS NOT NULL AND r.subcounty_id = p_subcounty_id
           OR p_subcounty_id IS NULL AND r.ward = p_ward)
    GROUP BY r.agent_id, p.full_name
    ORDER BY SUM(r.total) DESC;

  ELSIF p_level = 'landlord' THEN
    RETURN QUERY
    SELECT r.landlord_id::text, COALESCE(p.name, 'Unnamed landlord'),
           r.agent_id, r.landlord_id, NULL::text, p.name,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint,
           MAX(r.district_id)::int, MAX(r.subcounty_id)::int
    FROM mv_house_location_rollup r
    LEFT JOIN landlords p ON p.id = r.landlord_id
    WHERE r.country = p_country
      AND (p_district_id IS NOT NULL AND r.district_id = p_district_id
           OR p_district_id IS NULL AND r.region = p_region AND r.district = p_district)
      AND (p_subcounty_id IS NOT NULL AND r.subcounty_id = p_subcounty_id
           OR p_subcounty_id IS NULL AND r.ward = p_ward)
      AND r.agent_id = p_agent_id
    GROUP BY r.landlord_id, r.agent_id, p.name
    ORDER BY SUM(r.total) DESC;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_tenant_location_breakdown(p_level text, p_country text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_district text DEFAULT NULL::text, p_ward text DEFAULT NULL::text, p_agent_id uuid DEFAULT NULL::uuid, p_funded_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_funded_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_district_id integer DEFAULT NULL::integer, p_subcounty_id integer DEFAULT NULL::integer)
 RETURNS TABLE(key text, label text, agent_id uuid, landlord_id uuid, agent_name text, landlord_name text, total integer, occupied integer, vacant integer, hidden integer, revenue_ugx bigint, district_id integer, subcounty_id integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH funded_tenants AS (
    SELECT DISTINCT lp.tenant_id
    FROM landlord_payouts lp
    WHERE lp.tenant_id IS NOT NULL
      AND lp.disbursed_at IS NOT NULL
      AND (p_funded_since IS NULL OR lp.disbursed_at >= p_funded_since)
      AND (p_funded_until IS NULL OR lp.disbursed_at <  p_funded_until)
  ),
  scoped AS (
    SELECT t.*
    FROM v_tenant_location_pivot t
    WHERE
      ((p_funded_since IS NULL AND p_funded_until IS NULL)
       OR t.tenant_id IN (SELECT tenant_id FROM funded_tenants))
      AND (p_country  IS NULL OR t.country  = p_country)
      AND (p_region   IS NULL OR t.region   = p_region)
      AND (CASE WHEN p_district_id IS NOT NULL THEN t.district_id = p_district_id
                WHEN p_district   IS NOT NULL THEN t.district = p_district
                ELSE true END)
      AND (CASE WHEN p_subcounty_id IS NOT NULL THEN t.subcounty_id = p_subcounty_id
                WHEN p_ward         IS NOT NULL THEN t.ward = p_ward
                ELSE true END)
      AND (p_agent_id IS NULL OR t.agent_id = p_agent_id)
  )
  SELECT * FROM (
    SELECT s.country AS key, s.country AS label,
           NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE s.landlord_id IS NOT NULL)::int AS occupied,
           COUNT(*) FILTER (WHERE s.landlord_id IS NULL)::int     AS vacant,
           0::int AS hidden,
           COALESCE(SUM(s.rent_amount),0)::bigint AS revenue_ugx,
           NULL::int AS district_id, NULL::int AS subcounty_id
    FROM scoped s
    WHERE p_level = 'country'
    GROUP BY s.country

    UNION ALL
    SELECT s.region, s.region, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(s.rent_amount),0)::bigint,
           NULL::int, NULL::int
    FROM scoped s
    WHERE p_level = 'region'
    GROUP BY s.region

    UNION ALL
    SELECT s.district, s.district, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(s.rent_amount),0)::bigint,
           MAX(s.district_id)::int, NULL::int
    FROM scoped s
    WHERE p_level = 'district'
    GROUP BY s.district

    UNION ALL
    SELECT s.ward, s.ward, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(s.rent_amount),0)::bigint,
           MAX(s.district_id)::int, MAX(s.subcounty_id)::int
    FROM scoped s
    WHERE p_level = 'ward'
    GROUP BY s.ward

    UNION ALL
    SELECT COALESCE(s.agent_id::text,'unassigned'),
           COALESCE(p.full_name, CASE WHEN s.agent_id IS NULL THEN '— No agent on file' ELSE 'Unnamed agent' END),
           s.agent_id, NULL::uuid, p.full_name, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(s.rent_amount),0)::bigint,
           MAX(s.district_id)::int, MAX(s.subcounty_id)::int
    FROM scoped s
    LEFT JOIN profiles p ON p.id = s.agent_id
    WHERE p_level = 'agent'
    GROUP BY s.agent_id, p.full_name

    UNION ALL
    SELECT COALESCE(s.landlord_id::text,'unassigned'),
           COALESCE(p.name, CASE WHEN s.landlord_id IS NULL THEN '— No landlord on file' ELSE 'Unnamed landlord' END),
           NULL::uuid, s.landlord_id, NULL::text, p.name,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE s.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(s.rent_amount),0)::bigint,
           MAX(s.district_id)::int, MAX(s.subcounty_id)::int
    FROM scoped s
    LEFT JOIN landlords p ON p.id = s.landlord_id
    WHERE p_level = 'landlord'
    GROUP BY s.landlord_id, p.name
  ) q
  ORDER BY q.total DESC;
$function$;

CREATE OR REPLACE FUNCTION public.get_service_center_rent_queue(p_manager_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_manager uuid := COALESCE(p_manager_id, auth.uid());
  v_rows jsonb;
  v_reviewed jsonb;
BEGIN
  IF v_manager IS NULL THEN RAISE EXCEPTION 'manager required'; END IF;
  IF v_manager <> auth.uid() AND NOT public.is_ops_role(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at'), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'id', rr.id,
      'status', rr.status,
      'created_at', rr.created_at,
      'rent_amount', rr.rent_amount,
      'duration_days', rr.duration_days,
      'daily_repayment', rr.daily_repayment,
      'total_repayment', rr.total_repayment,
      'house_category', rr.house_category,
      'request_city', rr.request_city,
      'house_image_urls', rr.house_image_urls,
      'tenant_photo_url', rr.tenant_photo_url,
      'tenant_id', rr.tenant_id,
      'tenant_name', tp.full_name,
      'tenant_phone', tp.phone,
      'agent_id', rr.agent_id,
      'agent_name', ap.full_name,
      'agent_phone', ap.phone,
      'agent_avatar_url', ap.avatar_url,
      'landlord_name', lp.name,
      'landlord_phone', lp.phone
    ) AS x
    FROM public.rent_requests rr
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
    LEFT JOIN public.landlords lp ON lp.id = rr.landlord_id
    WHERE rr.service_center_manager_id = v_manager
      AND rr.status = 'service_center_review'
  ) s;

  SELECT COALESCE(jsonb_agg(y ORDER BY y->>'service_center_reviewed_at' DESC), '[]'::jsonb) INTO v_reviewed
  FROM (
    SELECT jsonb_build_object(
      'id', rr.id,
      'status', rr.status,
      'rent_amount', rr.rent_amount,
      'tenant_name', tp.full_name,
      'agent_name', ap.full_name,
      'service_center_reviewed_at', rr.service_center_reviewed_at,
      'service_center_comment', rr.service_center_comment
    ) AS y
    FROM public.rent_requests rr
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
    WHERE rr.service_center_manager_id = v_manager
      AND rr.service_center_reviewed_at IS NOT NULL
    ORDER BY rr.service_center_reviewed_at DESC
    LIMIT 25
  ) r;

  RETURN jsonb_build_object(
    'manager_id', v_manager,
    'is_service_center_manager', public.is_service_center_manager(v_manager),
    'pending_count', jsonb_array_length(v_rows),
    'pending', v_rows,
    'recent_reviewed', v_reviewed
  );
END; $function$;

CREATE OR REPLACE FUNCTION public.get_tenants_at_leaf(p_country text, p_region text, p_district text, p_ward text, p_agent_id uuid, p_landlord_id uuid, p_limit integer DEFAULT 300, p_funded_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_funded_until timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(tenant_id uuid, tenant_name text, tenant_phone text, tenant_avatar_url text, tenant_photo_url text, house_image_urls text[], house_category text, rent_amount numeric, rent_request_id uuid, agent_id uuid, agent_name text, landlord_id uuid, landlord_name text, country text, region text, district text, ward text, landlord_funded_at timestamp with time zone, landlord_funded_amount bigint, landlord_payout_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH payouts AS (
    SELECT lp.tenant_id,
           MAX(lp.disbursed_at) AS funded_at,
           COALESCE(SUM(lp.amount) FILTER (WHERE lp.disbursed_at IS NOT NULL), 0)::bigint AS funded_amount,
           COUNT(*) FILTER (WHERE lp.disbursed_at IS NOT NULL)::int AS payout_count
    FROM landlord_payouts lp
    WHERE lp.tenant_id IS NOT NULL
    GROUP BY lp.tenant_id
  )
  SELECT
    t.tenant_id, t.tenant_name, t.tenant_phone, t.tenant_avatar_url,
    t.tenant_photo_url, t.house_image_urls, t.house_category, t.rent_amount, t.rent_request_id,
    t.agent_id, pa.full_name, t.landlord_id, pl.name,
    t.country, t.region, t.district, t.ward,
    po.funded_at, COALESCE(po.funded_amount, 0)::bigint, COALESCE(po.payout_count, 0)::int
  FROM v_tenant_location_pivot t
  LEFT JOIN profiles pa ON pa.id = t.agent_id
  LEFT JOIN landlords pl ON pl.id = t.landlord_id
  LEFT JOIN payouts   po ON po.tenant_id = t.tenant_id
  WHERE t.country  = p_country
    AND t.region   = p_region
    AND t.district = p_district
    AND t.ward     = p_ward
    AND (t.agent_id    = p_agent_id    OR (p_agent_id    IS NULL AND t.agent_id    IS NULL))
    AND (t.landlord_id = p_landlord_id OR (p_landlord_id IS NULL AND t.landlord_id IS NULL))
    AND (p_funded_since IS NULL OR po.funded_at >= p_funded_since)
    AND (p_funded_until IS NULL OR po.funded_at <  p_funded_until)
  ORDER BY t.tenant_name NULLS LAST
  LIMIT GREATEST(p_limit, 1);
$function$;

CREATE OR REPLACE FUNCTION public.get_tenants_at_leaf(p_country text, p_region text, p_district text, p_ward text, p_agent_id uuid, p_landlord_id uuid, p_limit integer DEFAULT 300, p_funded_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_funded_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_outstanding text DEFAULT NULL::text, p_verification text DEFAULT NULL::text, p_funding_source text DEFAULT NULL::text)
 RETURNS TABLE(tenant_id uuid, tenant_name text, tenant_phone text, tenant_avatar_url text, tenant_photo_url text, house_image_urls text[], house_category text, rent_amount numeric, rent_request_id uuid, agent_id uuid, agent_name text, landlord_id uuid, landlord_name text, country text, region text, district text, ward text, landlord_funded_at timestamp with time zone, landlord_funded_amount bigint, landlord_payout_count integer, outstanding_status text, verification_status text, funding_source text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH payouts AS (
    SELECT lp.tenant_id,
           MAX(lp.disbursed_at) AS funded_at,
           COALESCE(SUM(lp.amount) FILTER (WHERE lp.disbursed_at IS NOT NULL), 0)::bigint AS funded_amount,
           COUNT(*) FILTER (WHERE lp.disbursed_at IS NOT NULL)::int AS payout_count
    FROM landlord_payouts lp
    WHERE lp.tenant_id IS NOT NULL
    GROUP BY lp.tenant_id
  ),
  rr AS (
    SELECT DISTINCT ON (r.tenant_id)
           r.tenant_id,
           r.supporter_id,
           r.total_repayment,
           r.amount_repaid,
           r.tenancy_status,
           r.outstanding_at_end,
           r.disbursed_at
    FROM rent_requests r
    WHERE r.tenant_id IS NOT NULL
    ORDER BY r.tenant_id, r.disbursed_at DESC NULLS LAST, r.created_at DESC
  ),
  base AS (
    SELECT
      t.tenant_id, t.tenant_name, t.tenant_phone, t.tenant_avatar_url,
      t.tenant_photo_url, t.house_image_urls, t.house_category, t.rent_amount, t.rent_request_id,
      t.agent_id, pa.full_name AS agent_name, t.landlord_id, pl.name AS landlord_name,
      t.country, t.region, t.district, t.ward,
      po.funded_at AS landlord_funded_at,
      COALESCE(po.funded_amount, 0)::bigint AS landlord_funded_amount,
      COALESCE(po.payout_count, 0)::int AS landlord_payout_count,
      CASE
        WHEN rr.tenancy_status IN ('ended','defaulted') AND COALESCE(rr.outstanding_at_end,0) > 0 THEN 'defaulted'
        WHEN rr.total_repayment IS NULL OR rr.total_repayment <= 0 THEN 'partial'
        WHEN COALESCE(rr.amount_repaid,0) >= rr.total_repayment THEN 'paid_up'
        WHEN COALESCE(rr.amount_repaid,0) <= 0 AND rr.disbursed_at IS NOT NULL AND rr.disbursed_at < now() - interval '30 days' THEN 'overdue'
        WHEN COALESCE(rr.amount_repaid,0) > 0 THEN 'partial'
        ELSE 'overdue'
      END AS outstanding_status,
      CASE
        WHEN ts.ai_id IS NOT NULL AND length(ts.ai_id) > 0 THEN 'verified'
        WHEN ts.user_id IS NOT NULL THEN 'pending'
        ELSE 'missing'
      END AS verification_status,
      CASE
        WHEN rr.supporter_id IS NOT NULL THEN 'supporter'
        ELSE 'platform'
      END AS funding_source
    FROM v_tenant_location_pivot t
    LEFT JOIN profiles pa ON pa.id = t.agent_id
    LEFT JOIN landlords pl ON pl.id = t.landlord_id
    LEFT JOIN payouts  po ON po.tenant_id = t.tenant_id
    LEFT JOIN rr        ON rr.tenant_id = t.tenant_id
    LEFT JOIN welile_trust_score_cache ts ON ts.user_id = t.tenant_id
    WHERE t.country  = p_country
      AND t.region   = p_region
      AND t.district = p_district
      AND t.ward     = p_ward
      AND (t.agent_id    = p_agent_id    OR (p_agent_id    IS NULL AND t.agent_id    IS NULL))
      AND (t.landlord_id = p_landlord_id OR (p_landlord_id IS NULL AND t.landlord_id IS NULL))
      AND (p_funded_since IS NULL OR po.funded_at >= p_funded_since)
      AND (p_funded_until IS NULL OR po.funded_at <  p_funded_until)
  )
  SELECT * FROM base
  WHERE (p_outstanding     IS NULL OR outstanding_status   = p_outstanding)
    AND (p_verification    IS NULL OR verification_status  = p_verification)
    AND (p_funding_source  IS NULL OR funding_source       = p_funding_source)
  ORDER BY tenant_name NULLS LAST
  LIMIT GREATEST(p_limit, 1);
$function$;

CREATE OR REPLACE FUNCTION public.ops_recent_agent_inactivations(p_limit integer DEFAULT 25, p_since_hours integer DEFAULT 336)
 RETURNS TABLE(rent_request_id uuid, tenant_id uuid, tenant_name text, tenant_phone text, tenant_city text, agent_id uuid, agent_name text, agent_phone text, reason text, marked_at timestamp with time zone, review_status text, review_notes text, acknowledged_at timestamp with time zone, reviewer_name text, rent_amount numeric, daily_repayment numeric, total_repayment numeric, amount_repaid numeric, outstanding numeric, funded_at timestamp with time zone, days_since_funded integer, last_collection_at timestamp with time zone, last_collection_amount numeric, collections_count integer, days_since_last_collection integer, landlord_name text, landlord_phone text, house_title text, house_area text, trust_score numeric, tenancy_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  RETURN QUERY
  SELECT
    rr.id,
    rr.tenant_id,
    tp.full_name,
    tp.phone,
    tp.city,
    rr.agent_id,
    ap.full_name,
    agp.phone,
    rr.agent_payment_status_reason,
    rr.agent_payment_status_set_at,
    COALESCE(tir.status, 'open'),
    tir.notes,
    tir.acknowledged_at,
    rp.full_name,
    rr.rent_amount,
    rr.daily_repayment,
    rr.total_repayment,
    COALESCE(rr.amount_repaid, 0),
    GREATEST(COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0), 0),
    rr.funded_at,
    CASE WHEN rr.funded_at IS NOT NULL
      THEN EXTRACT(DAY FROM (now() - rr.funded_at))::int END,
    col.last_at,
    col.last_amount,
    COALESCE(col.cnt, 0)::int,
    CASE WHEN col.last_at IS NOT NULL
      THEN EXTRACT(DAY FROM (now() - col.last_at))::int END,
    lp.name,
    lp.phone,
    hl.title,
    NULLIF(concat_ws(', ', hl.district, hl.region), ''),
    ts.score,
    rr.tenancy_status
  FROM public.rent_requests rr
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = rr.agent_payment_status_set_by
  LEFT JOIN public.profiles agp ON agp.id = rr.agent_id
  LEFT JOIN public.landlords lp ON lp.id = rr.landlord_id
  LEFT JOIN public.house_listings hl ON hl.id = rr.house_listing_id
  LEFT JOIN public.welile_trust_score_cache ts ON ts.user_id = rr.tenant_id
  LEFT JOIN public.tenant_inactive_reviews tir ON tir.rent_request_id = rr.id
  LEFT JOIN public.profiles rp ON rp.id = COALESCE(tir.resolved_by, tir.rejected_by, tir.acknowledged_by)
  LEFT JOIN LATERAL (
    SELECT max(ac.created_at) AS last_at,
           count(*) AS cnt,
           (SELECT ac2.amount FROM public.agent_collections ac2
             WHERE ac2.tenant_id = rr.tenant_id
             ORDER BY ac2.created_at DESC LIMIT 1) AS last_amount
    FROM public.agent_collections ac
    WHERE ac.tenant_id = rr.tenant_id
  ) col ON true
  WHERE rr.agent_payment_status = 'not_paying'
    AND rr.agent_payment_status_set_at >= now() - make_interval(hours => GREATEST(p_since_hours, 1))
    AND rr.agent_payment_status_set_by IS NOT NULL
    AND rr.agent_payment_status_set_by = rr.agent_id
    AND COALESCE(tir.status, 'open') NOT IN ('resolved', 'rejected')
  ORDER BY rr.agent_payment_status_set_at DESC
  LIMIT GREATEST(LEAST(p_limit, 100), 1);
END;
$function$;

CREATE OR REPLACE FUNCTION public.ops_search_tenant_rents(p_search text)
 RETURNS TABLE(rent_request_id uuid, tenant_id uuid, tenant_name text, tenant_phone text, agent_id uuid, agent_name text, landlord_name text, status text, rent_amount numeric, total_repayment numeric, amount_repaid numeric, daily_repayment numeric, outstanding numeric, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    rr.id,
    rr.tenant_id,
    tp.full_name,
    tp.phone,
    rr.agent_id,
    ap.full_name,
    lp.name,
    rr.status,
    rr.rent_amount,
    rr.total_repayment,
    rr.amount_repaid,
    rr.daily_repayment,
    GREATEST(COALESCE(rr.total_repayment,0) - COALESCE(rr.amount_repaid,0), 0),
    rr.created_at
  FROM public.rent_requests rr
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
  LEFT JOIN public.landlords lp ON lp.id = rr.landlord_id
  WHERE public.is_tenant_ops_staff(auth.uid())
    AND (
      p_search IS NULL OR length(trim(p_search)) < 2 OR
      tp.full_name ILIKE '%' || trim(p_search) || '%' OR
      tp.phone ILIKE '%' || trim(p_search) || '%' OR
      tp.national_id ILIKE '%' || trim(p_search) || '%' OR
      ap.full_name ILIKE '%' || trim(p_search) || '%'
    )
  ORDER BY rr.created_at DESC
  LIMIT 50;
$function$;

CREATE OR REPLACE FUNCTION public.ops_tenant_ops_tool_report(p_tool text, p_status text DEFAULT 'all'::text, p_search text DEFAULT NULL::text, p_date_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_date_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 5000)
 RETURNS TABLE(row_data jsonb, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tool text := lower(coalesce(p_tool, ''));
  v_status text := lower(coalesce(nullif(btrim(coalesce(p_status,'')), ''), 'all'));
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_like text;
  v_limit int := least(greatest(coalesce(p_limit, 5000), 1), 10000);
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  v_like := CASE WHEN v_q IS NULL THEN NULL ELSE '%' || v_q || '%' END;

  IF v_tool = 'review_requests' THEN
    RETURN QUERY
    WITH base AS (
      SELECT rr.*,
             tp.full_name AS tenant_name, tp.phone AS tenant_phone,
             ap.full_name AS agent_name, ap.phone AS agent_phone,
             lp.name AS landlord_name
      FROM rent_requests rr
      LEFT JOIN profiles tp ON tp.id = rr.tenant_id
      LEFT JOIN profiles ap ON ap.id = rr.agent_id
      LEFT JOIN landlords lp ON lp.id = rr.landlord_id
      WHERE rr.status IN ('pending','service_center_review','agent_ops_approved','agent_verified','tenant_ops_approved','coo_approved','funded')
        AND (v_status = 'all' OR rr.status = v_status)
        AND (p_date_from IS NULL OR rr.created_at >= p_date_from)
        AND (p_date_to IS NULL OR rr.created_at < p_date_to)
        AND (v_like IS NULL OR tp.full_name ILIKE v_like OR tp.phone ILIKE v_like
             OR ap.full_name ILIKE v_like OR rr.request_city ILIKE v_like)
    ), counted AS (SELECT count(*) AS c FROM base)
    SELECT jsonb_build_object(
             'id', b.id,
             'tenant_name', COALESCE(b.tenant_name, 'Unknown'),
             'tenant_phone', b.tenant_phone,
             'agent_name', b.agent_name,
             'agent_phone', b.agent_phone,
             'landlord_name', b.landlord_name,
             'status', b.status,
             'rent_amount', COALESCE(b.rent_amount,0),
             'total_repayment', COALESCE(b.total_repayment,0),
             'daily_repayment', COALESCE(b.daily_repayment,0),
             'duration_days', b.duration_days,
             'house_category', b.house_category,
             'request_city', b.request_city,
             'request_country', b.request_country,
             'has_gps', (b.request_latitude IS NOT NULL AND b.request_longitude IS NOT NULL),
             'registration_type', b.registration_type,
             'service_center_reviewed_at', b.service_center_reviewed_at,
             'agent_verified_at', b.agent_verified_at,
             'tenant_ops_reviewed_at', b.tenant_ops_reviewed_at,
             'resubmission_count', COALESCE(b.resubmission_count,0),
             'created_at', b.created_at,
             'updated_at', b.updated_at
           ), (SELECT c FROM counted)
    FROM base b
    ORDER BY b.created_at DESC
    LIMIT v_limit;

  ELSIF v_tool = 'approval_history' THEN
    RETURN QUERY
    WITH base AS (
      SELECT rr.*,
             tp.full_name AS tenant_name, tp.phone AS tenant_phone,
             ap.full_name AS agent_name,
             t1.full_name AS tenant_ops_by, a1.full_name AS agent_ops_by,
             l1.full_name AS landlord_ops_by, c1.full_name AS coo_by, f1.full_name AS cfo_by
      FROM rent_requests rr
      LEFT JOIN profiles tp ON tp.id = rr.tenant_id
      LEFT JOIN profiles ap ON ap.id = rr.agent_id
      LEFT JOIN profiles t1 ON t1.id = rr.tenant_ops_reviewed_by
      LEFT JOIN profiles a1 ON a1.id = rr.agent_verified_by
      LEFT JOIN profiles l1 ON l1.id = rr.landlord_ops_reviewed_by
      LEFT JOIN profiles c1 ON c1.id = rr.coo_reviewed_by
      LEFT JOIN profiles f1 ON f1.id = rr.cfo_reviewed_by
      WHERE (
              rr.tenant_ops_reviewed_at IS NOT NULL OR rr.agent_verified_at IS NOT NULL
              OR rr.landlord_ops_reviewed_at IS NOT NULL OR rr.coo_reviewed_at IS NOT NULL
              OR rr.cfo_reviewed_at IS NOT NULL OR rr.status IN ('rejected','funded','repaying','completed','defaulted')
            )
        AND (v_status = 'all' OR rr.status = v_status)
        AND (p_date_from IS NULL OR rr.updated_at >= p_date_from)
        AND (p_date_to IS NULL OR rr.updated_at < p_date_to)
        AND (v_like IS NULL OR tp.full_name ILIKE v_like OR tp.phone ILIKE v_like OR ap.full_name ILIKE v_like)
    ), counted AS (SELECT count(*) AS c FROM base)
    SELECT jsonb_build_object(
             'id', b.id,
             'tenant_name', COALESCE(b.tenant_name, 'Unknown'),
             'tenant_phone', b.tenant_phone,
             'agent_name', b.agent_name,
             'status', b.status,
             'rent_amount', COALESCE(b.rent_amount,0),
             'request_city', b.request_city,
             'house_category', b.house_category,
             'tenant_ops_by', b.tenant_ops_by, 'tenant_ops_at', b.tenant_ops_reviewed_at,
             'agent_ops_by', b.agent_ops_by, 'agent_ops_at', b.agent_verified_at,
             'landlord_ops_by', b.landlord_ops_by, 'landlord_ops_at', b.landlord_ops_reviewed_at,
             'coo_by', b.coo_by, 'coo_at', b.coo_reviewed_at,
             'cfo_by', b.cfo_by, 'cfo_at', b.cfo_reviewed_at,
             'rejected_reason', b.rejected_reason,
             'rejected_at_stage', b.rejected_at_stage,
             'approval_comment', b.approval_comment,
             'created_at', b.created_at,
             'updated_at', b.updated_at
           ), (SELECT c FROM counted)
    FROM base b
    ORDER BY b.updated_at DESC
    LIMIT v_limit;

  ELSIF v_tool IN ('missed_days','calls_made') THEN
    RETURN QUERY
    WITH calc AS (
      -- `disbursed_at` is absent on most repaying plans, so the repayment clock
      -- is anchored on disbursed_at -> funded_at -> created_at. Filtering on
      -- disbursed_at alone hid the majority of active plans from this report.
      SELECT rr.id, rr.tenant_id, rr.agent_id, rr.status,
             COALESCE(rr.disbursed_at, rr.funded_at, rr.created_at) AS disbursed_at,
             COALESCE(rr.rent_amount,0) AS rent_amount,
             COALESCE(rr.total_repayment,0) AS total_repayment,
             COALESCE(rr.amount_repaid,0) AS amount_repaid,
             COALESCE(rr.daily_repayment,0) AS daily_repayment,
             GREATEST(1, (date_part('day', now() - COALESCE(rr.disbursed_at, rr.funded_at, rr.created_at)))::int) AS days_since,
             LEAST(COALESCE(rr.daily_repayment,0) * GREATEST(1, (date_part('day', now() - COALESCE(rr.disbursed_at, rr.funded_at, rr.created_at)))::int), COALESCE(rr.total_repayment,0)) AS expected_repaid
      FROM rent_requests rr
      WHERE rr.status IN ('funded','disbursed','repaying')
        AND (p_date_from IS NULL OR COALESCE(rr.disbursed_at, rr.funded_at, rr.created_at) >= p_date_from)
        AND (p_date_to IS NULL OR COALESCE(rr.disbursed_at, rr.funded_at, rr.created_at) < p_date_to)
    ), enriched AS (
      SELECT c.*,
             GREATEST(0, round((c.expected_repaid - c.amount_repaid) / NULLIF(c.daily_repayment,0)))::int AS missed_days,
             GREATEST(0, c.total_repayment - c.amount_repaid) AS outstanding_balance,
             tp.full_name AS tenant_name, tp.phone AS tenant_phone,
             ap.full_name AS agent_name, ap.phone AS agent_phone,
             (SELECT max(ac.created_at) FROM agent_collections ac WHERE ac.tenant_id = c.tenant_id) AS last_payment_at,
             (SELECT COALESCE(sum(ac.amount),0) FROM agent_collections ac WHERE ac.tenant_id = c.tenant_id) AS lifetime_collected
      FROM calc c
      LEFT JOIN profiles tp ON tp.id = c.tenant_id
      LEFT JOIN profiles ap ON ap.id = c.agent_id
    ), base AS (
      SELECT e.*,
             CASE WHEN e.missed_days >= 5 THEN 'critical'
                  WHEN e.missed_days >= 2 THEN 'warning'
                  ELSE 'on_track' END AS risk_level
      FROM enriched e
    ), filtered AS (
      SELECT b.*,
             COALESCE(cs.call_count,0) AS call_count,
             cs.last_call_at, cs.last_outcome, cs.latest_comment,
             cs.last_picked_up_at
      FROM base b
      LEFT JOIN v_tenant_call_summary cs ON cs.tenant_id = b.tenant_id
      WHERE (v_status = 'all' OR b.risk_level = v_status)
        AND (v_like IS NULL OR b.tenant_name ILIKE v_like OR b.tenant_phone ILIKE v_like OR b.agent_name ILIKE v_like)
        AND (v_tool <> 'calls_made' OR COALESCE(cs.call_count,0) > 0)
    ), counted AS (SELECT count(*) AS c FROM filtered)
    SELECT jsonb_build_object(
             'id', f.id,
             'tenant_id', f.tenant_id,
             'tenant_name', COALESCE(f.tenant_name, 'Unknown'),
             'tenant_phone', f.tenant_phone,
             'agent_name', f.agent_name,
             'agent_phone', f.agent_phone,
             'status', f.status,
             'risk_level', f.risk_level,
             'missed_days', f.missed_days,
             'days_since_disbursed', f.days_since,
             'daily_repayment', f.daily_repayment,
             'rent_amount', f.rent_amount,
             'total_repayment', f.total_repayment,
             'amount_repaid', f.amount_repaid,
             'expected_repaid', f.expected_repaid,
             'outstanding_balance', f.outstanding_balance,
             'repayment_pct', CASE WHEN f.total_repayment > 0 THEN round((f.amount_repaid / f.total_repayment) * 100, 1) ELSE 0 END,
             'lifetime_collected', f.lifetime_collected,
             'last_payment_at', f.last_payment_at,
             'disbursed_at', f.disbursed_at,
             'call_count', COALESCE(f.call_count,0),
             'last_call_at', f.last_call_at,
             'last_call_outcome', f.last_outcome,
             'last_picked_up_at', f.last_picked_up_at,
             'latest_call_comment', f.latest_comment
           ), (SELECT c FROM counted)
    FROM filtered f
    ORDER BY (CASE WHEN v_tool = 'calls_made' THEN f.last_call_at END) DESC NULLS LAST,
             f.missed_days DESC, f.outstanding_balance DESC
    LIMIT v_limit;

  ELSIF v_tool = 'daily_payments' THEN
    RETURN QUERY
    WITH base AS (
      SELECT ac.*, tp.full_name AS tenant_name, tp.phone AS tenant_phone,
             ap.full_name AS agent_name, ap.phone AS agent_phone
      FROM agent_collections ac
      LEFT JOIN profiles tp ON tp.id = ac.tenant_id
      LEFT JOIN profiles ap ON ap.id = ac.agent_id
      WHERE (p_date_from IS NULL OR ac.created_at >= p_date_from)
        AND (p_date_to IS NULL OR ac.created_at < p_date_to)
        AND (v_status = 'all' OR lower(COALESCE(ac.payment_method::text,'unknown')) = v_status)
        AND (v_like IS NULL OR tp.full_name ILIKE v_like OR tp.phone ILIKE v_like
             OR ap.full_name ILIKE v_like OR ac.momo_transaction_id ILIKE v_like OR ac.tracking_id ILIKE v_like)
    ), counted AS (SELECT count(*) AS c FROM base)
    SELECT jsonb_build_object(
             'id', b.id,
             'tenant_name', COALESCE(b.tenant_name, 'Unknown'),
             'tenant_phone', b.tenant_phone,
             'agent_name', b.agent_name,
             'agent_phone', b.agent_phone,
             'amount', COALESCE(b.amount,0),
             'payment_method', b.payment_method,
             'momo_provider', b.momo_provider,
             'momo_transaction_id', b.momo_transaction_id,
             'tracking_id', b.tracking_id,
             'location_name', b.location_name,
             'rent_request_id', b.rent_request_id,
             'has_gps', (b.latitude IS NOT NULL AND b.longitude IS NOT NULL),
             'created_at', b.created_at
           ), (SELECT c FROM counted)
    FROM base b
    ORDER BY b.created_at DESC
    LIMIT v_limit;

  ELSIF v_tool = 'tenant_behavior' THEN
    RETURN QUERY
    WITH base AS (
      SELECT ts.*, tp.full_name AS tenant_name, tp.phone AS tenant_phone
      FROM tenant_trust_scores ts
      LEFT JOIN profiles tp ON tp.id = ts.tenant_id
      WHERE (p_date_from IS NULL OR ts.updated_at >= p_date_from)
        AND (p_date_to IS NULL OR ts.updated_at < p_date_to)
        AND (
          v_status = 'all'
          OR (v_status = 'excellent' AND COALESCE(ts.trust_score,0) >= 80)
          OR (v_status = 'good' AND COALESCE(ts.trust_score,0) >= 60 AND COALESCE(ts.trust_score,0) < 80)
          OR (v_status = 'fair' AND COALESCE(ts.trust_score,0) >= 40 AND COALESCE(ts.trust_score,0) < 60)
          OR (v_status = 'poor' AND COALESCE(ts.trust_score,0) < 40)
        )
        AND (v_like IS NULL OR tp.full_name ILIKE v_like OR tp.phone ILIKE v_like)
    ), counted AS (SELECT count(*) AS c FROM base)
    SELECT jsonb_build_object(
             'id', b.id,
             'tenant_id', b.tenant_id,
             'tenant_name', COALESCE(b.tenant_name, 'Unknown'),
             'tenant_phone', b.tenant_phone,
             'trust_score', COALESCE(b.trust_score,0),
             'on_time_payments', COALESCE(b.on_time_payments,0),
             'late_payments', COALESCE(b.late_payments,0),
             'missed_payments', COALESCE(b.missed_payments,0),
             'total_payments', COALESCE(b.total_payments,0),
             'consecutive_on_time', COALESCE(b.consecutive_on_time,0),
             'longest_streak', COALESCE(b.longest_streak,0),
             'avg_days_late', COALESCE(b.avg_days_late,0),
             'total_repaid', COALESCE(b.total_repaid,0),
             'last_payment_at', b.last_payment_at,
             'updated_at', b.updated_at
           ), (SELECT c FROM counted)
    FROM base b
    ORDER BY COALESCE(b.trust_score,0) DESC
    LIMIT v_limit;

  ELSIF v_tool = 'transfer_audit' THEN
    RETURN QUERY
    WITH base AS (
      SELECT tt.*, tp.full_name AS tenant_name, tp.phone AS tenant_phone,
             fa.full_name AS from_agent_name, ta.full_name AS to_agent_name,
             ab.full_name AS actor_name
      FROM tenant_transfers tt
      LEFT JOIN profiles tp ON tp.id = tt.tenant_id
      LEFT JOIN profiles fa ON fa.id = tt.from_agent_id
      LEFT JOIN profiles ta ON ta.id = tt.to_agent_id
      LEFT JOIN profiles ab ON ab.id = tt.transferred_by
      WHERE (p_date_from IS NULL OR tt.created_at >= p_date_from)
        AND (p_date_to IS NULL OR tt.created_at < p_date_to)
        AND (v_status = 'all' OR lower(COALESCE(tt.flag_type,'none')) = v_status)
        AND (v_like IS NULL OR tp.full_name ILIKE v_like OR tp.phone ILIKE v_like
             OR fa.full_name ILIKE v_like OR ta.full_name ILIKE v_like OR ab.full_name ILIKE v_like)
    ), counted AS (SELECT count(*) AS c FROM base)
    SELECT jsonb_build_object(
             'id', b.id,
             'tenant_name', COALESCE(b.tenant_name, 'Unknown'),
             'tenant_phone', b.tenant_phone,
             'from_agent_name', b.from_agent_name,
             'to_agent_name', b.to_agent_name,
             'actor_name', b.actor_name,
             'flag_type', COALESCE(b.flag_type,'none'),
             'reason', b.reason,
             'rent_requests_updated', COALESCE(b.rent_requests_updated,0),
             'subscriptions_updated', COALESCE(b.subscriptions_updated,0),
             'actor_location_status', b.actor_location_status,
             'has_gps', (b.actor_latitude IS NOT NULL AND b.actor_longitude IS NOT NULL),
             'created_at', b.created_at
           ), (SELECT c FROM counted)
    FROM base b
    ORDER BY b.created_at DESC
    LIMIT v_limit;

  ELSE
    RAISE EXCEPTION 'unknown tool: %', p_tool;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_ops_list_rent_requests(p_status text DEFAULT 'landlord_ops_approved'::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_lim int := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_off int := GREATEST(COALESCE(p_offset, 0), 0);
  v_status text := COALESCE(NULLIF(p_status, ''), 'landlord_ops_approved');
  v_q text := NULLIF(TRIM(COALESCE(p_search, '')), '');
  v_total int;
  v_rows jsonb;
  v_proxies jsonb;
BEGIN
  IF NOT public.is_partner_ops(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorised for Partner Operations' USING ERRCODE = '42501';
  END IF;

  IF v_status NOT IN ('landlord_ops_approved', 'partner_ops_approved', 'all') THEN
    v_status := 'landlord_ops_approved';
  END IF;

  WITH base AS (
    SELECT r.*,
           tp.full_name AS tenant_name, tp.phone AS tenant_phone,
           ap.full_name AS agent_name,  ap.phone AS agent_phone,
           lp.name AS landlord_name, lp.phone AS landlord_phone,
           xp.full_name AS proxy_agent_name, xp.phone AS proxy_agent_phone
      FROM public.rent_requests r
      LEFT JOIN public.profiles tp ON tp.id = r.tenant_id
      LEFT JOIN public.profiles ap ON ap.id = COALESCE(r.assigned_agent_id, r.agent_id)
      LEFT JOIN public.landlords lp ON lp.id = r.landlord_id
      LEFT JOIN public.profiles xp ON xp.id = r.proxy_agent_id
     WHERE (v_status = 'all' OR r.status = v_status)
       AND (v_status = 'all' OR r.status <> 'landlord_ops_approved'
            OR r.registration_type IS NULL
            OR r.registration_type <> 'outstanding_balance')
  ), filtered AS (
    SELECT * FROM base
     WHERE v_q IS NULL
        OR tenant_name ILIKE '%' || v_q || '%'
        OR tenant_phone ILIKE '%' || v_q || '%'
        OR agent_name ILIKE '%' || v_q || '%'
        OR landlord_name ILIKE '%' || v_q || '%'
        OR request_city ILIKE '%' || v_q || '%'
  ), counted AS (
    SELECT COUNT(*)::int AS total FROM filtered
  ), page AS (
    SELECT * FROM filtered
     ORDER BY landlord_ops_reviewed_at DESC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC
     LIMIT v_lim OFFSET v_off
  )
  SELECT (SELECT total FROM counted),
         COALESCE(jsonb_agg(jsonb_build_object(
           'id', id,
           'status', status,
           'created_at', created_at,
           'landlord_ops_reviewed_at', landlord_ops_reviewed_at,
           'rent_amount', rent_amount,
           'duration_days', duration_days,
           'daily_repayment', daily_repayment,
           'total_repayment', total_repayment,
           'house_category', house_category,
           'request_city', request_city,
           'registration_type', registration_type,
           'tenant_id', tenant_id,
           'tenant_name', COALESCE(tenant_name, 'Tenant'),
           'tenant_phone', tenant_phone,
           'agent_id', COALESCE(assigned_agent_id, agent_id),
           'agent_name', agent_name,
           'agent_phone', agent_phone,
           'landlord_name', landlord_name,
           'landlord_phone', landlord_phone,
           'proxy_agent_id', proxy_agent_id,
           'proxy_agent_name', proxy_agent_name,
           'proxy_agent_phone', proxy_agent_phone,
           'partner_ops_comment', partner_ops_comment,
           'partner_ops_reviewed_at', partner_ops_reviewed_at,
           'agent_ops_comment', agent_ops_comment,
           'tenant_ops_comment', tenant_ops_comment,
           'landlord_ops_comment', landlord_ops_comment,
           'tenant_photo_url', tenant_photo_url,
           'house_image_urls', COALESCE(house_image_urls, ARRAY[]::text[]),
           'latest_rent_receipt_url', latest_rent_receipt_url,
           'latest_rent_receipt_uploaded_at', latest_rent_receipt_uploaded_at
         ) ORDER BY landlord_ops_reviewed_at DESC NULLS LAST, created_at DESC), '[]'::jsonb)
    INTO v_total, v_rows
    FROM page;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_user_id', i.agent_user_id,
           'full_name', COALESCE(p.full_name, i.full_name, 'Proxy agent'),
           'phone', COALESCE(p.phone, i.phone),
           'approved_at', i.reviewed_at
         ) ORDER BY COALESCE(p.full_name, i.full_name)), '[]'::jsonb)
    INTO v_proxies
    FROM public.proxy_agent_identity i
    LEFT JOIN public.profiles p ON p.id = i.agent_user_id
   WHERE i.status = 'approved';

  RETURN jsonb_build_object(
    'total', COALESCE(v_total, 0),
    'limit', v_lim,
    'offset', v_off,
    'status', v_status,
    'rows', v_rows,
    'proxy_agents', v_proxies,
    'generated_at', now()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_ops_pending_portfolio_lines(p_portfolio_id uuid)
 RETURNS TABLE(line_id uuid, line_kind text, principal numeric, subject_id uuid, subject_name text, subject_phone text, location text, daily_repayment numeric, counterparty_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'partner_ops') OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised to view portfolio lines';
  END IF;

  RETURN QUERY
  -- Tenant-bound rent plan lines
  SELECT l.id,
         'tenant'::text,
         l.principal,
         rr.tenant_id,
         coalesce(p.full_name, 'Tenant')::text,
         p.phone::text,
         nullif(concat_ws(', ', rr.request_city, rr.request_country), '')::text,
         rr.daily_repayment,
         NULL::text
  FROM public.funder_pending_portfolios fp
  JOIN public.partner_self_funding_lines l ON l.commitment_id = fp.commitment_id
  LEFT JOIN public.rent_requests rr ON rr.id = l.rent_request_id
  LEFT JOIN public.profiles p ON p.id = rr.tenant_id
  WHERE fp.portfolio_id = p_portfolio_id
    AND coalesce(l.status, 'active') <> 'cancelled'

  UNION ALL

  -- Verified empty-house support lines
  SELECT s.id,
         'house'::text,
         s.principal,
         s.house_id,
         coalesce(
           nullif(h.title, ''),
           nullif(replace(coalesce(h.house_category, ''), '_', ' '), ''),
           'Empty house'
         )::text,
         lp.phone::text,
         nullif(concat_ws(', ', nullif(h.address, ''), nullif(h.village, ''), nullif(h.district, '')), '')::text,
         NULL::numeric,
         nullif(lp.name, '')::text
  FROM public.funder_pending_portfolios fp
  JOIN public.partner_supported_houses s ON s.commitment_id = fp.commitment_id
  LEFT JOIN public.house_listings h ON h.id = s.house_id
  LEFT JOIN public.landlords lp ON lp.id = s.landlord_id
  WHERE fp.portfolio_id = p_portfolio_id
    AND coalesce(s.status, 'active') <> 'cancelled'

  ORDER BY 3 DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_self_portfolio(p_partner_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_target uuid := COALESCE(p_partner_id, auth.uid());
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF v_target <> v_uid AND NOT (
      public.is_ops_role(v_uid) OR public.has_role(v_uid,'partner_ops') OR public.has_role(v_uid,'financial_ops') OR public.has_role(v_uid,'cfo') OR public.has_role(v_uid,'coo')
      OR public.has_role(v_uid,'ceo') OR public.has_role(v_uid,'manager') OR public.has_role(v_uid,'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE='42501';
  END IF;

  RETURN (
    WITH house_agg AS (
      SELECT commitment_id, COUNT(*) AS house_count,
             MIN(portfolio_id) AS portfolio_id,
             MIN(metadata->>'portfolio_code') AS portfolio_code
      FROM public.partner_supported_houses
      WHERE partner_id = v_target AND status <> 'cancelled'
      GROUP BY commitment_id
    ),
    line_agg AS (
      SELECT commitment_id, COUNT(*) AS line_count
      FROM public.partner_self_funding_lines
      WHERE partner_id = v_target AND status <> 'cancelled'
      GROUP BY commitment_id
    ),
    commitments AS (
      SELECT c.*,
             CASE WHEN COALESCE(h.house_count,0) > 0 THEN 'houses'
                  WHEN COALESCE(l.line_count,0) > 0 THEN 'rent'
                  ELSE 'unknown' END AS kind,
             h.portfolio_id AS house_portfolio_id,
             h.portfolio_code AS portfolio_code,
             COALESCE(h.house_count,0) AS house_count,
             COALESCE(l.line_count,0) AS rent_line_count
      FROM public.partner_self_commitments c
      LEFT JOIN house_agg h ON h.commitment_id = c.id
      LEFT JOIN line_agg  l ON l.commitment_id = c.id
      WHERE c.partner_id = v_target
    ),
    lines AS (
      SELECT l.*, rr.rent_amount, rr.duration_days, rr.daily_repayment,
             rr.request_city, rr.house_category, rr.status AS plan_status,
             rr.disbursed_at, rr.amount_repaid,
             split_part(COALESCE(NULLIF(btrim(tp.full_name),''),'Tenant'),' ',1) AS tenant_first_name,
             tp.full_name AS tenant_full_name,
             tp.avatar_url AS tenant_avatar_url,
             COALESCE(NULLIF(btrim(lp.name),''),'Landlord') AS landlord_name
      FROM public.partner_self_funding_lines l
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
      LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
      LEFT JOIN public.landlords lp ON lp.id = rr.landlord_id
      WHERE l.partner_id = v_target AND l.status <> 'cancelled'
    ),
    holds AS (
      SELECT * FROM public.partner_self_plan_claims
      WHERE partner_id = v_target AND status='held' AND expires_at > now()
    ),
    payouts AS (
      SELECT * FROM public.partner_self_payout_cycles WHERE partner_id = v_target
    )
    SELECT jsonb_build_object(
      'available_balance', public.get_user_available_balance(v_target),
      'minimum_funding', 50000,
      'totals', jsonb_build_object(
        'committed', (SELECT COALESCE(SUM(committed_amount),0) FROM commitments WHERE status <> 'cancelled'),
        'active', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='active'),
        'earning', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='active'),
        'idle', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='idle'),
        'completed', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='completed'),
        'total_earned', (SELECT COALESCE(SUM(total_earned),0) FROM commitments),
        'total_paid', (SELECT COALESCE(SUM(total_paid),0) FROM commitments),
        'lines_count', (SELECT COUNT(*) FROM lines)
      ),
      'commitments', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC), '[]'::jsonb) FROM commitments c),
      'lines', (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.created_at DESC), '[]'::jsonb) FROM lines l),
      'active_holds', (SELECT COALESCE(jsonb_agg(to_jsonb(h)), '[]'::jsonb) FROM holds h),
      'payout_cycles', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.cycle_end DESC), '[]'::jsonb) FROM payouts p),
      'next_payout', (SELECT jsonb_build_object('date', MIN(next_payout_at))
                        FROM commitments WHERE status='active' AND next_payout_at IS NOT NULL)
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.search_locations(p_query text, p_limit integer DEFAULT 25)
 RETURNS TABLE(kind text, label text, country text, region text, district text, ward text, agent_id uuid, landlord_id uuid, total integer, district_id integer, subcounty_id integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  q text := '%' || lower(trim(p_query)) || '%';
BEGIN
  IF p_query IS NULL OR length(trim(p_query)) < 2 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT 'country', r.country, r.country, NULL::text, NULL::text, NULL::text, NULL::uuid, NULL::uuid, SUM(r.total)::int, NULL::int, NULL::int
  FROM mv_house_location_rollup r
  WHERE lower(r.country) LIKE q
  GROUP BY r.country
  UNION ALL
  SELECT 'region', r.region || ', ' || r.country, r.country, r.region, NULL::text, NULL::text, NULL::uuid, NULL::uuid, SUM(r.total)::int, NULL::int, NULL::int
  FROM mv_house_location_rollup r
  WHERE lower(r.region) LIKE q
  GROUP BY r.country, r.region
  UNION ALL
  SELECT 'district', r.district || ', ' || r.region, r.country, r.region, r.district, NULL::text, NULL::uuid, NULL::uuid, SUM(r.total)::int, MAX(r.district_id)::int, NULL::int
  FROM mv_house_location_rollup r
  WHERE lower(r.district) LIKE q
  GROUP BY r.country, r.region, r.district
  UNION ALL
  SELECT 'ward', r.ward || ', ' || r.district, r.country, r.region, r.district, r.ward, NULL::uuid, NULL::uuid, SUM(r.total)::int, MAX(r.district_id)::int, MAX(r.subcounty_id)::int
  FROM mv_house_location_rollup r
  WHERE lower(r.ward) LIKE q
  GROUP BY r.country, r.region, r.district, r.ward
  UNION ALL
  SELECT 'agent', COALESCE(p.full_name,'Unnamed agent'), NULL::text, NULL::text, NULL::text, NULL::text, p.id, NULL::uuid, COALESCE(SUM(r.total),0)::int, NULL::int, NULL::int
  FROM profiles p
  LEFT JOIN mv_house_location_rollup r ON r.agent_id = p.id
  WHERE lower(COALESCE(p.full_name,'')) LIKE q OR lower(COALESCE(p.phone,'')) LIKE q
  GROUP BY p.id, p.full_name
  HAVING COALESCE(SUM(r.total),0) > 0
  UNION ALL
  SELECT 'landlord', COALESCE(p.name,'Unnamed landlord'), NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid, p.id, COALESCE(SUM(r.total),0)::int, NULL::int, NULL::int
  FROM landlords p
  LEFT JOIN mv_house_location_rollup r ON r.landlord_id = p.id
  WHERE lower(COALESCE(p.name,'')) LIKE q OR lower(COALESCE(p.phone,'')) LIKE q
  GROUP BY p.id, p.name
  HAVING COALESCE(SUM(r.total),0) > 0
  ORDER BY 9 DESC NULLS LAST
  LIMIT p_limit;
END;
$function$;

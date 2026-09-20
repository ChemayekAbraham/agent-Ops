-- Historical empty-house density and rent-needed series, derived from listing
-- dates and funding dates so it works retroactively (no snapshot backfill).
CREATE OR REPLACE FUNCTION public.map_empty_house_trend(
  p_start date,
  p_end date,
  p_bucket text DEFAULT 'week',
  p_district text DEFAULT NULL,
  p_min_rent numeric DEFAULT NULL,
  p_max_rent numeric DEFAULT NULL,
  p_region_limit integer DEFAULT 8
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_bucket text := lower(COALESCE(NULLIF(btrim(p_bucket), ''), 'week'));
  v_step interval;
  v_start date := LEAST(COALESCE(p_start, current_date - 90), COALESCE(p_end, current_date));
  v_end date := GREATEST(COALESCE(p_end, current_date), COALESCE(p_start, current_date - 90));
  v_district text := NULLIF(btrim(COALESCE(p_district, '')), '');
  v_region_limit integer := LEAST(GREATEST(COALESCE(p_region_limit, 8), 1), 20);
  v_result jsonb;
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

  IF v_bucket NOT IN ('day', 'week', 'month') THEN
    v_bucket := 'week';
  END IF;
  v_step := CASE v_bucket WHEN 'day' THEN interval '1 day'
                          WHEN 'month' THEN interval '1 month'
                          ELSE interval '1 week' END;

  -- Keep the series bounded: at most ~120 points regardless of range.
  IF v_bucket = 'day' AND (v_end - v_start) > 120 THEN
    v_bucket := 'week';
    v_step := interval '1 week';
  END IF;
  IF v_bucket = 'week' AND (v_end - v_start) > 840 THEN
    v_bucket := 'month';
    v_step := interval '1 month';
  END IF;

  WITH houses AS (
    SELECT
      COALESCE(NULLIF(btrim(h.region), ''), NULLIF(btrim(h.district), ''), 'Unspecified area') AS region,
      h.created_at AS listed_at,
      COALESCE(h.monthly_rent, 0)::numeric AS rent,
      CASE
        -- Still an open empty-house opportunity today: never exited.
        WHEN h.status = 'available'
             AND h.tenant_id IS NULL
             AND COALESCE(h.is_hidden, false) = false
             AND NOT EXISTS (
               SELECT 1 FROM public.promissory_note_house_intents i
               WHERE i.house_id = h.id AND i.status = 'reserved')
             AND NOT EXISTS (
               SELECT 1 FROM public.partner_supported_houses psh
               WHERE psh.house_id = h.id AND psh.status IN ('pending', 'active'))
          THEN NULL
        ELSE COALESCE(
          (SELECT min(psh.supported_at) FROM public.partner_supported_houses psh
            WHERE psh.house_id = h.id AND psh.status IN ('pending', 'active')),
          h.updated_at,
          h.created_at)
      END AS exit_at
    FROM public.house_listings h
    WHERE COALESCE(h.monthly_rent, 0) > 0
      AND h.geo_point IS NOT NULL
      AND h.created_at IS NOT NULL
      AND (v_district IS NULL OR h.district ILIKE v_district)
      AND (p_min_rent IS NULL OR COALESCE(h.monthly_rent, 0) >= p_min_rent)
      AND (p_max_rent IS NULL OR COALESCE(h.monthly_rent, 0) <= p_max_rent)
  ),
  buckets AS (
    SELECT gs::date AS bucket_start,
           -- Measured at the close of the bucket, in Uganda local time.
           ((gs + v_step)::timestamp AT TIME ZONE 'Africa/Kampala') AS measured_at
    FROM generate_series(
      date_trunc(v_bucket, v_start::timestamp),
      date_trunc(v_bucket, v_end::timestamp),
      v_step) AS gs
  ),
  points AS (
    SELECT b.bucket_start, h.region,
           COUNT(*)::bigint AS empty_count,
           COALESCE(SUM(h.rent), 0)::numeric AS rent_needed
    FROM buckets b
    JOIN houses h
      ON h.listed_at < b.measured_at
     AND (h.exit_at IS NULL OR h.exit_at >= b.measured_at)
    GROUP BY b.bucket_start, h.region
  ),
  totals AS (
    SELECT b.bucket_start,
           COALESCE(SUM(p.empty_count), 0)::bigint AS empty_count,
           COALESCE(SUM(p.rent_needed), 0)::numeric AS rent_needed
    FROM buckets b
    LEFT JOIN points p ON p.bucket_start = b.bucket_start
    GROUP BY b.bucket_start
  ),
  ranked AS (
    SELECT region,
           MAX(bucket_start) AS last_bucket,
           (ARRAY_AGG(empty_count ORDER BY bucket_start DESC))[1] AS latest_count
    FROM points GROUP BY region
    ORDER BY latest_count DESC NULLS LAST, region
    LIMIT v_region_limit
  ),
  region_series AS (
    SELECT r.region,
           jsonb_agg(jsonb_build_object(
             'bucket', b.bucket_start,
             'empty_count', COALESCE(p.empty_count, 0),
             'rent_needed', COALESCE(p.rent_needed, 0)
           ) ORDER BY b.bucket_start) AS series,
           (ARRAY_AGG(COALESCE(p.empty_count, 0) ORDER BY b.bucket_start))[1] AS first_count,
           (ARRAY_AGG(COALESCE(p.empty_count, 0) ORDER BY b.bucket_start DESC))[1] AS last_count,
           (ARRAY_AGG(COALESCE(p.rent_needed, 0) ORDER BY b.bucket_start))[1] AS first_rent,
           (ARRAY_AGG(COALESCE(p.rent_needed, 0) ORDER BY b.bucket_start DESC))[1] AS last_rent
    FROM ranked r
    CROSS JOIN buckets b
    LEFT JOIN points p ON p.region = r.region AND p.bucket_start = b.bucket_start
    GROUP BY r.region
  )
  SELECT jsonb_build_object(
    'bucket', v_bucket,
    'start', v_start,
    'end', v_end,
    'totals', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'bucket', bucket_start, 'empty_count', empty_count, 'rent_needed', rent_needed)
        ORDER BY bucket_start) FROM totals), '[]'::jsonb),
    'regions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'region', region,
        'series', series,
        'first_count', first_count,
        'last_count', last_count,
        'count_change', last_count - first_count,
        'first_rent', first_rent,
        'last_rent', last_rent,
        'rent_change', last_rent - first_rent)
        ORDER BY last_count DESC, region) FROM region_series), '[]'::jsonb)
  ) INTO v_result;

  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$function$;

REVOKE ALL ON FUNCTION public.map_empty_house_trend(date, date, text, text, numeric, numeric, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.map_empty_house_trend(date, date, text, text, numeric, numeric, integer) TO authenticated;
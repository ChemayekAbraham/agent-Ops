-- Replace the temp-table implementation with a pure CTE + window-count version so
-- the read-only STABLE function performs no DDL. Behaviour is unchanged.
CREATE OR REPLACE FUNCTION public.landlord_ops_payouts_geo_page(
  p_scope text DEFAULT 'all_time',
  p_search text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL,
  p_country text DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0,
  p_sort text DEFAULT 'amount',
  p_dir text DEFAULT 'desc'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_q text := NULLIF(TRIM(COALESCE(p_search, '')), '');
  v_country text := NULLIF(TRIM(COALESCE(p_country, '')), '');
  v_region text := NULLIF(TRIM(COALESCE(p_region, '')), '');
  v_district text := NULLIF(TRIM(COALESCE(p_district, '')), '');
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 200);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_sort text := LOWER(COALESCE(NULLIF(TRIM(p_sort), ''), 'amount'));
  v_desc boolean := LOWER(COALESCE(p_dir, 'desc')) <> 'asc';
  v_result jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       public.is_ops_role(v_uid)
       OR has_role(v_uid,'landlord_ops') OR has_role(v_uid,'tenant_ops')
       OR has_role(v_uid,'agent_ops') OR has_role(v_uid,'operations')
       OR has_role(v_uid,'financial_ops')
       OR has_role(v_uid,'cfo') OR has_role(v_uid,'coo') OR has_role(v_uid,'ceo')
       OR has_role(v_uid,'cto') OR has_role(v_uid,'manager') OR has_role(v_uid,'super_admin')
     ) THEN
    RAISE EXCEPTION 'Not authorised to view landlord payouts';
  END IF;

  IF v_sort NOT IN ('amount','payouts','country','region','district') THEN
    v_sort := 'amount';
  END IF;

  WITH base AS (
    SELECT COALESCE(lp.amount,0) AS amount,
           COALESCE(
             NULLIF(TRIM(hl.district), ''),
             NULLIF(TRIM(ld.district), ''),
             NULLIF(TRIM(tp.district), '')
           ) AS raw_district
    FROM landlord_payouts lp
    LEFT JOIN landlords ld ON ld.id = lp.landlord_id
    LEFT JOIN profiles tp ON tp.id = lp.tenant_id
    LEFT JOIN profiles ap ON ap.id = lp.agent_id
    LEFT JOIN rent_requests rr ON rr.id = lp.rent_request_id
    LEFT JOIN house_listings hl ON hl.id = rr.house_listing_id
    WHERE (
            CASE
              WHEN p_scope = 'completed' THEN lp.status = 'completed'
              ELSE lp.status <> 'failed'
                   AND COALESCE(lp.finops_disbursed_at, lp.disbursed_at) IS NOT NULL
            END
          )
      AND (p_agent_id IS NULL OR lp.agent_id = p_agent_id)
      AND (
            p_from IS NULL
            OR (COALESCE(lp.finops_disbursed_at, lp.disbursed_at, lp.created_at)
                  AT TIME ZONE 'Africa/Kampala')::date >= p_from
          )
      AND (
            p_to IS NULL
            OR (COALESCE(lp.finops_disbursed_at, lp.disbursed_at, lp.created_at)
                  AT TIME ZONE 'Africa/Kampala')::date <= p_to
          )
      AND (
            v_q IS NULL
            OR COALESCE(lp.landlord_name,'') ILIKE '%' || v_q || '%'
            OR COALESCE(ld.name,'') ILIKE '%' || v_q || '%'
            OR COALESCE(lp.landlord_phone,'') ILIKE '%' || v_q || '%'
            OR COALESCE(ld.phone,'') ILIKE '%' || v_q || '%'
            OR COALESCE(tp.full_name,'') ILIKE '%' || v_q || '%'
            OR COALESCE(ap.full_name,'') ILIKE '%' || v_q || '%'
            OR COALESCE(lp.finops_momo_reference,'') ILIKE '%' || v_q || '%'
            OR COALESCE(lp.external_reference,'') ILIKE '%' || v_q || '%'
            OR COALESCE(lp.receipt_number,'') ILIKE '%' || v_q || '%'
            OR COALESCE(lp.mobile_money_provider,'') ILIKE '%' || v_q || '%'
            OR COALESCE(lp.amount,0)::text ILIKE '%' || v_q || '%'
            OR lp.id::text ILIKE '%' || v_q || '%'
          )
  ), mapped AS (
    SELECT b.amount,
           CASE WHEN da.district_id IS NOT NULL THEN 'Uganda' ELSE 'Unmapped' END AS country,
           COALESCE(da.region, 'Unmapped') AS region,
           COALESCE(da.district_name, b.raw_district, 'Unspecified') AS district,
           (da.district_id IS NULL) AS unmatched
    FROM base b
    LEFT JOIN v_ug_district_alias_all da
      ON da.norm_key = ug_norm_name(b.raw_district)
  ), grouped AS (
    SELECT country, region, district,
           COUNT(*)::bigint AS payouts,
           SUM(amount) AS amount,
           bool_and(unmatched) AS unmatched
    FROM mapped
    WHERE (v_country IS NULL OR country = v_country)
      AND (v_region IS NULL OR region = v_region)
      AND (v_district IS NULL OR district = v_district)
    GROUP BY country, region, district
  ), totals AS (
    SELECT COUNT(*)::bigint AS total_count,
           COALESCE(SUM(amount),0) AS total_amount,
           COALESCE(SUM(payouts),0)::bigint AS total_payouts
    FROM grouped
  ), page AS (
    SELECT jsonb_build_object(
             'country', country,
             'region', region,
             'district', district,
             'payouts', payouts,
             'amount', amount,
             'unmatched', unmatched
           ) AS x
    FROM grouped
    ORDER BY
      CASE WHEN v_sort = 'amount'   AND v_desc THEN amount END DESC NULLS LAST,
      CASE WHEN v_sort = 'amount'   AND NOT v_desc THEN amount END ASC NULLS LAST,
      CASE WHEN v_sort = 'payouts'  AND v_desc THEN payouts END DESC NULLS LAST,
      CASE WHEN v_sort = 'payouts'  AND NOT v_desc THEN payouts END ASC NULLS LAST,
      CASE WHEN v_sort = 'country'  AND v_desc THEN country END DESC NULLS LAST,
      CASE WHEN v_sort = 'country'  AND NOT v_desc THEN country END ASC NULLS LAST,
      CASE WHEN v_sort = 'region'   AND v_desc THEN region END DESC NULLS LAST,
      CASE WHEN v_sort = 'region'   AND NOT v_desc THEN region END ASC NULLS LAST,
      CASE WHEN v_sort = 'district' AND v_desc THEN district END DESC NULLS LAST,
      CASE WHEN v_sort = 'district' AND NOT v_desc THEN district END ASC NULLS LAST,
      country ASC, region ASC, district ASC
    LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
           'as_at', now(),
           'rows', COALESCE((SELECT jsonb_agg(x) FROM page), '[]'::jsonb),
           'total_count', t.total_count,
           'total_amount', t.total_amount,
           'total_payouts', t.total_payouts,
           'limit', v_limit,
           'offset', v_offset
         )
  INTO v_result
  FROM totals t;

  RETURN v_result;
END;
$function$;
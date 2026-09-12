-- Make the read-only landlord-float geo functions resolve districts through
-- v_ug_district_alias_all so operator-mapped spellings move out of Unmapped
-- immediately. Recorded location text is still never rewritten.

CREATE OR REPLACE FUNCTION public.landlord_ops_float_needed_geo()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       public.is_ops_role(auth.uid())
       OR has_role(v_uid,'landlord_ops') OR has_role(v_uid,'tenant_ops')
       OR has_role(v_uid,'agent_ops') OR has_role(v_uid,'operations')
       OR has_role(v_uid,'financial_ops')
       OR has_role(v_uid,'cfo') OR has_role(v_uid,'coo') OR has_role(v_uid,'ceo')
       OR has_role(v_uid,'cto') OR has_role(v_uid,'manager') OR has_role(v_uid,'super_admin')
     ) THEN
    RAISE EXCEPTION 'Not authorised to view the landlord float overview';
  END IF;

  WITH empty_h AS (
    SELECT
      da.district_id,
      CASE WHEN da.district_id IS NOT NULL THEN 'Uganda' ELSE 'Unmapped' END AS country,
      COALESCE(da.region, 'Unmapped') AS region,
      COALESCE(da.district_name, NULLIF(TRIM(hl.district), ''), 'Unspecified') AS district,
      COALESCE(hl.monthly_rent, 0) AS amount
    FROM house_listings hl
    LEFT JOIN v_ug_district_alias_all da
      ON da.norm_key = ug_norm_name(NULLIF(hl.district, ''))
    WHERE hl.tenant_id IS NULL
      AND COALESCE(hl.is_hidden, false) = false
      AND hl.status = 'available'
  ),
  waiting_h AS (
    SELECT
      da.district_id,
      CASE WHEN da.district_id IS NOT NULL THEN 'Uganda' ELSE 'Unmapped' END AS country,
      COALESCE(da.region, 'Unmapped') AS region,
      COALESCE(da.district_name, NULLIF(TRIM(COALESCE(NULLIF(ld.district,''), NULLIF(tp.district,''))), ''), 'Unspecified') AS district,
      COALESCE(rr.rent_amount, 0) AS amount
    FROM rent_requests rr
    LEFT JOIN landlords ld ON ld.id = rr.landlord_id
    LEFT JOIN profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN v_ug_district_alias_all da
      ON da.norm_key = ug_norm_name(COALESCE(NULLIF(ld.district, ''), NULLIF(tp.district, '')))
    WHERE rr.funded_at IS NULL
      AND rr.status IN ('pending','service_center_review','tenant_ops_approved','landlord_ops_approved','agent_ops_approved')
  ),
  combined AS (
    SELECT country, region, district, amount, 1 AS empty_n, 0 AS waiting_n FROM empty_h
    UNION ALL
    SELECT country, region, district, amount, 0 AS empty_n, 1 AS waiting_n FROM waiting_h
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT jsonb_build_object(
             'country', country,
             'region', region,
             'district', district,
             'empty_houses', SUM(empty_n),
             'empty_amount', SUM(CASE WHEN empty_n = 1 THEN amount ELSE 0 END),
             'waiting_houses', SUM(waiting_n),
             'waiting_amount', SUM(CASE WHEN waiting_n = 1 THEN amount ELSE 0 END),
             'houses', COUNT(*),
             'amount', SUM(amount)
           ) AS x
    FROM combined
    GROUP BY country, region, district
  ) s;

  RETURN jsonb_build_object('as_at', now(), 'rows', v_rows);
END;
$function$;

CREATE OR REPLACE FUNCTION public.landlord_ops_float_needed_district_rows(p_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.is_ops_role(v_uid) THEN
    RAISE EXCEPTION 'Not authorised to view the landlord float drilldown';
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT jsonb_build_object(
             'id', hl.id,
             'source', 'Empty house',
             'name', COALESCE(NULLIF(hl.title,''),'Untitled house'),
             'recorded_district', COALESCE(NULLIF(TRIM(hl.district),''),'Unspecified'),
             'landlord_name', COALESCE(ld.name,'No landlord linked'),
             'landlord_phone', COALESCE(ld.phone, ld.mobile_money_number),
             'agent_name', ap.full_name,
             'sub_county', hl.sub_county,
             'village', hl.village,
             'amount', COALESCE(hl.monthly_rent,0),
             'created_at', hl.created_at
           ) AS x
    FROM house_listings hl
    LEFT JOIN landlords ld ON ld.id = hl.landlord_id
    LEFT JOIN profiles ap ON ap.id = hl.agent_id
    LEFT JOIN v_ug_district_alias_all da
      ON da.norm_key = ug_norm_name(NULLIF(hl.district, ''))
    WHERE hl.tenant_id IS NULL
      AND COALESCE(hl.is_hidden,false) = false
      AND hl.status = 'available'
      AND COALESCE(da.district_name, NULLIF(TRIM(hl.district), ''), 'Unspecified') = p_key
    UNION ALL
    SELECT jsonb_build_object(
             'id', rr.id,
             'source', 'Awaiting funding',
             'name', COALESCE(tp.full_name,'Unnamed tenant'),
             'recorded_district', COALESCE(NULLIF(TRIM(COALESCE(NULLIF(ld.district,''), NULLIF(tp.district,''))),''),'Unspecified'),
             'landlord_name', COALESCE(ld.name,'No landlord linked'),
             'landlord_phone', COALESCE(ld.phone, ld.mobile_money_number),
             'agent_name', ap.full_name,
             'sub_county', NULL,
             'village', NULL,
             'amount', COALESCE(rr.rent_amount,0),
             'created_at', rr.created_at
           ) AS x
    FROM rent_requests rr
    LEFT JOIN profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN landlords ld ON ld.id = rr.landlord_id
    LEFT JOIN profiles ap ON ap.id = rr.agent_id
    LEFT JOIN v_ug_district_alias_all da
      ON da.norm_key = ug_norm_name(COALESCE(NULLIF(ld.district, ''), NULLIF(tp.district, '')))
    WHERE rr.funded_at IS NULL
      AND rr.status IN ('pending','service_center_review','tenant_ops_approved','landlord_ops_approved','agent_ops_approved')
      AND COALESCE(da.district_name, NULLIF(TRIM(COALESCE(NULLIF(ld.district,''), NULLIF(tp.district,''))), ''), 'Unspecified') = p_key
    LIMIT 500
  ) s;

  RETURN jsonb_build_object('rows', v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_ops_float_needed_district_rows(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landlord_ops_float_needed_district_rows(text) TO authenticated;

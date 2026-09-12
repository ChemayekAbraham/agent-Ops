-- Read-only holistic geographic drilldown for landlord float BEING COLLECTED.
-- Country -> Region -> District -> County -> Sub-county -> Parish -> Village/Cell -> House.
-- Location is resolved through the approved Uganda hierarchy (house ug_village_id first,
-- then landlord ug_village_id, then approved district aliases). Recorded location text is
-- never rewritten: spellings that match nothing stay visible under "Unmapped".
CREATE OR REPLACE FUNCTION public.landlord_ops_collecting_geo_page(
  p_level text DEFAULT 'country',
  p_country text DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_county text DEFAULT NULL,
  p_subcounty text DEFAULT NULL,
  p_parish text DEFAULT NULL,
  p_village text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_q text := NULLIF(TRIM(COALESCE(p_search, '')), '');
  v_level text := COALESCE(NULLIF(TRIM(p_level), ''), 'country');
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 200);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_rows jsonb := '[]'::jsonb;
  v_totals jsonb;
  v_count bigint := 0;
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
    RAISE EXCEPTION 'Not authorised to view the landlord float overview';
  END IF;

  IF v_level NOT IN ('country','region','district','county','subcounty','parish','village','houses') THEN
    RAISE EXCEPTION 'Unknown drilldown level: %', v_level;
  END IF;

  WITH b AS (
    SELECT
      rr.id                                        AS rent_request_id,
      rr.status,
      rr.funded_at,
      COALESCE(rr.rent_amount,0)                   AS rent_amount,
      COALESCE(rr.total_repayment,0)               AS contracted,
      COALESCE(rr.amount_repaid,0)                 AS collected,
      GREATEST(COALESCE(rr.total_repayment,0) - COALESCE(rr.amount_repaid,0), 0) AS outstanding,
      COALESCE(rr.daily_repayment,0)               AS daily_repayment,
      hl.id                                        AS house_listing_id,
      hl.title                                     AS house_title,
      COALESCE(NULLIF(TRIM(hl.address),''), NULLIF(TRIM(ld.property_address),'')) AS house_address,
      COALESCE(
        (SELECT u FROM unnest(COALESCE(hl.image_urls, ARRAY[]::text[])) u WHERE NULLIF(TRIM(u),'') IS NOT NULL LIMIT 1),
        (SELECT u FROM unnest(COALESCE(rr.house_image_urls, ARRAY[]::text[])) u WHERE NULLIF(TRIM(u),'') IS NOT NULL LIMIT 1)
      )                                            AS house_image_url,
      COALESCE(hl.latitude, ld.latitude::double precision)   AS latitude,
      COALESCE(hl.longitude, ld.longitude::double precision) AS longitude,
      ld.id                                        AS landlord_id,
      COALESCE(ld.name,'No landlord linked')       AS landlord_name,
      COALESCE(ld.phone, ld.mobile_money_number)   AS landlord_phone,
      ld.mobile_money_name,
      ld.mobile_money_number,
      ld.caretaker_name,
      ld.caretaker_phone,
      tp.id                                        AS tenant_id,
      COALESCE(tp.full_name,'Unnamed tenant')      AS tenant_name,
      tp.phone                                     AS tenant_phone,
      ap.id                                        AS agent_id,
      ap.full_name                                 AS agent_name,
      ap.phone                                     AS agent_phone,
      hl.lc1_chairperson_name,
      hl.lc1_chairperson_phone,
      CASE WHEN v.id IS NOT NULL OR da.district_id IS NOT NULL THEN 'Uganda' ELSE 'Unmapped' END AS country,
      COALESCE(d.region, da.region, 'Unmapped')    AS region,
      COALESCE(d.name, da.district_name, NULLIF(TRIM(hl.district),''), NULLIF(TRIM(ld.district),''), 'Unmapped') AS district,
      COALESCE(c.name, NULLIF(TRIM(ld.county),''), 'Unmapped') AS county,
      COALESCE(sc.name, NULLIF(TRIM(hl.sub_county),''), NULLIF(TRIM(ld.sub_county),''), 'Unmapped') AS subcounty,
      COALESCE(pa.name, 'Unmapped')                AS parish,
      COALESCE(v.name, NULLIF(TRIM(hl.village),''), NULLIF(TRIM(ld.village),''), NULLIF(TRIM(ld.cell),''), 'Unmapped') AS village,
      (v.id IS NOT NULL)                           AS geo_official
    FROM rent_requests rr
    LEFT JOIN house_listings hl ON hl.id = rr.house_listing_id
    LEFT JOIN landlords ld ON ld.id = rr.landlord_id
    LEFT JOIN profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN profiles ap ON ap.id = COALESCE(rr.assigned_agent_id, rr.agent_id)
    LEFT JOIN ug_villages v ON v.id = COALESCE(hl.ug_village_id, ld.ug_village_id)
    LEFT JOIN ug_parishes pa ON pa.id = v.parish_id
    LEFT JOIN ug_subcounties sc ON sc.id = pa.subcounty_id
    LEFT JOIN ug_counties c ON c.id = sc.county_id
    LEFT JOIN ug_districts d ON d.id = c.district_id
    LEFT JOIN v_ug_district_alias_all da
      ON da.norm_key = ug_norm_name(COALESCE(NULLIF(hl.district,''), NULLIF(ld.district,'')))
    WHERE rr.status IN ('funded','repaying')
  ), f AS (
    SELECT * FROM b
    WHERE (p_country   IS NULL OR country   = p_country)
      AND (p_region    IS NULL OR region    = p_region)
      AND (p_district  IS NULL OR district  = p_district)
      AND (p_county    IS NULL OR county    = p_county)
      AND (p_subcounty IS NULL OR subcounty = p_subcounty)
      AND (p_parish    IS NULL OR parish    = p_parish)
      AND (p_village   IS NULL OR village   = p_village)
  ), s AS (
    SELECT * FROM f
    WHERE v_q IS NULL
      OR (
        CASE v_level
          WHEN 'country'   THEN country
          WHEN 'region'    THEN region
          WHEN 'district'  THEN district
          WHEN 'county'    THEN county
          WHEN 'subcounty' THEN subcounty
          WHEN 'parish'    THEN parish
          WHEN 'village'   THEN village
          ELSE COALESCE(house_title,'') || ' ' || COALESCE(house_address,'') || ' ' ||
               tenant_name || ' ' || COALESCE(tenant_phone,'') || ' ' ||
               landlord_name || ' ' || COALESCE(landlord_phone,'') || ' ' ||
               COALESCE(agent_name,'') || ' ' || COALESCE(agent_phone,'')
        END
      ) ILIKE '%' || v_q || '%'
  ), grouped AS (
    SELECT
      CASE v_level
        WHEN 'country'   THEN country
        WHEN 'region'    THEN region
        WHEN 'district'  THEN district
        WHEN 'county'    THEN county
        WHEN 'subcounty' THEN subcounty
        WHEN 'parish'    THEN parish
        ELSE village
      END AS label,
      COUNT(*)                  AS plans,
      SUM(contracted)           AS contracted,
      SUM(collected)            AS collected,
      SUM(outstanding)          AS outstanding,
      SUM(daily_repayment)      AS daily_repayment,
      COUNT(DISTINCT house_listing_id) AS houses,
      COUNT(*) FILTER (WHERE geo_official) AS official_rows
    FROM s
    WHERE v_level <> 'houses'
    GROUP BY 1
  )
  SELECT
    CASE WHEN v_level = 'houses' THEN
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'rent_request_id', rent_request_id,
          'house_listing_id', house_listing_id,
          'house_title', house_title,
          'house_address', house_address,
          'house_image_url', house_image_url,
          'latitude', latitude,
          'longitude', longitude,
          'country', country, 'region', region, 'district', district,
          'county', county, 'subcounty', subcounty, 'parish', parish, 'village', village,
          'geo_official', geo_official,
          'landlord_id', landlord_id,
          'landlord_name', landlord_name,
          'landlord_phone', landlord_phone,
          'mobile_money_name', mobile_money_name,
          'mobile_money_number', mobile_money_number,
          'caretaker_name', caretaker_name,
          'caretaker_phone', caretaker_phone,
          'lc1_chairperson_name', lc1_chairperson_name,
          'lc1_chairperson_phone', lc1_chairperson_phone,
          'tenant_id', tenant_id,
          'tenant_name', tenant_name,
          'tenant_phone', tenant_phone,
          'agent_id', agent_id,
          'agent_name', agent_name,
          'agent_phone', agent_phone,
          'status', status,
          'funded_at', funded_at,
          'rent_amount', rent_amount,
          'contracted', contracted,
          'collected', collected,
          'outstanding', outstanding,
          'daily_repayment', daily_repayment
        ) ORDER BY outstanding DESC, tenant_name)
        FROM (
          SELECT * FROM s ORDER BY outstanding DESC, tenant_name LIMIT v_limit OFFSET v_offset
        ) hs
      ), '[]'::jsonb)
    ELSE
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'label', label,
          'plans', plans,
          'houses', houses,
          'contracted', contracted,
          'collected', collected,
          'outstanding', outstanding,
          'daily_repayment', daily_repayment,
          'unmatched', (label = 'Unmapped' OR official_rows = 0)
        ) ORDER BY outstanding DESC, label)
        FROM (
          SELECT * FROM grouped ORDER BY outstanding DESC, label LIMIT v_limit OFFSET v_offset
        ) gs
      ), '[]'::jsonb)
    END,
    CASE WHEN v_level = 'houses'
      THEN (SELECT COUNT(*) FROM s)
      ELSE (SELECT COUNT(*) FROM grouped)
    END,
    (SELECT jsonb_build_object(
       'plans', COUNT(*),
       'houses', COUNT(DISTINCT house_listing_id),
       'contracted', COALESCE(SUM(contracted),0),
       'collected', COALESCE(SUM(collected),0),
       'outstanding', COALESCE(SUM(outstanding),0),
       'daily_repayment', COALESCE(SUM(daily_repayment),0)
     ) FROM s)
  INTO v_rows, v_count, v_totals;

  RETURN jsonb_build_object(
    'as_at', now(),
    'level', v_level,
    'rows', v_rows,
    'total_rows', v_count,
    'totals', COALESCE(v_totals, jsonb_build_object('plans',0,'houses',0,'contracted',0,'collected',0,'outstanding',0,'daily_repayment',0))
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_ops_collecting_geo_page(text,text,text,text,text,text,text,text,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landlord_ops_collecting_geo_page(text,text,text,text,text,text,text,text,text,integer,integer) TO authenticated;
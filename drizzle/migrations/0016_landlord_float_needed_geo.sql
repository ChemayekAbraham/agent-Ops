-- Read-only geographic breakdown of landlord float NEEDED (empty listed houses
-- plus tenant-occupied houses still waiting for funding), grouped through the
-- approved Uganda hierarchy: country -> region -> district. Legacy district
-- text that matches no approved district stays visible under Unmapped with its
-- original spelling; nothing is written or normalised.

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
    LEFT JOIN mv_ug_district_alias da
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
    LEFT JOIN mv_ug_district_alias da
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

REVOKE ALL ON FUNCTION public.landlord_ops_float_needed_geo() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landlord_ops_float_needed_geo() TO authenticated;

-- Extend the drilldown with a district-scoped "float needed" listing that uses
-- the same canonical district mapping as the geo summary above, so the row
-- counts always agree. p_key is the canonical district name ('Unspecified'
-- rows included via their legacy spelling).
CREATE OR REPLACE FUNCTION public.landlord_ops_float_drilldown(p_kind text, p_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb := '[]'::jsonb;
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
    RAISE EXCEPTION 'Not authorised to view the landlord float drilldown';
  END IF;

  IF p_kind = 'empty_houses' THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
               'id', hl.id,
               'title', COALESCE(NULLIF(hl.title,''),'Untitled house'),
               'district', COALESCE(NULLIF(hl.district,''),'Unspecified'),
               'sub_county', hl.sub_county,
               'village', hl.village,
               'landlord_name', COALESCE(ld.name,'No landlord linked'),
               'landlord_phone', COALESCE(ld.phone, ld.mobile_money_number),
               'agent_name', ap.full_name,
               'verified', COALESCE(hl.verified,false),
               'amount', COALESCE(hl.monthly_rent,0),
               'created_at', hl.created_at
             ) AS x
      FROM house_listings hl
      LEFT JOIN landlords ld ON ld.id = hl.landlord_id
      LEFT JOIN profiles ap ON ap.id = hl.agent_id
      WHERE hl.tenant_id IS NULL
        AND COALESCE(hl.is_hidden,false) = false
        AND hl.status = 'available'
        AND (p_key IS NULL OR COALESCE(NULLIF(hl.district,''),'Unspecified') = p_key)
      ORDER BY COALESCE(hl.monthly_rent,0) DESC
      LIMIT 500
    ) s;

  ELSIF p_kind = 'needed_district' THEN
    -- Both halves of the float need in one district, tagged by source.
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
               'id', hl.id,
               'source', 'Empty house',
               'name', COALESCE(NULLIF(hl.title,''),'Untitled house'),
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
      LEFT JOIN mv_ug_district_alias da
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
      LEFT JOIN mv_ug_district_alias da
        ON da.norm_key = ug_norm_name(COALESCE(NULLIF(ld.district, ''), NULLIF(tp.district, '')))
      WHERE rr.funded_at IS NULL
        AND rr.status IN ('pending','service_center_review','tenant_ops_approved','landlord_ops_approved','agent_ops_approved')
        AND COALESCE(da.district_name, NULLIF(TRIM(COALESCE(NULLIF(ld.district,''), NULLIF(tp.district,''))), ''), 'Unspecified') = p_key
      ORDER BY 1 DESC
      LIMIT 500
    ) s;

  ELSIF p_kind = 'payouts' THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'created_at') DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
               'id', lp.id,
               'landlord_name', COALESCE(NULLIF(lp.landlord_name,''), ld.name, 'No landlord linked'),
               'landlord_phone', COALESCE(lp.landlord_phone, ld.phone),
               'tenant_name', tp.full_name,
               'agent_name', ap.full_name,
               'amount', COALESCE(lp.amount,0),
               'provider', lp.mobile_money_provider,
               'reference', COALESCE(lp.finops_momo_reference, lp.external_reference, lp.receipt_number),
               'disbursed_at', COALESCE(lp.finops_disbursed_at, lp.disbursed_at),
               'created_at', lp.created_at
             ) AS x
      FROM landlord_payouts lp
      LEFT JOIN landlords ld ON ld.id = lp.landlord_id
      LEFT JOIN profiles tp ON tp.id = lp.tenant_id
      LEFT JOIN profiles ap ON ap.id = lp.agent_id
      WHERE lp.status = 'completed'
        AND (p_key IS NULL OR lp.agent_id::text = p_key)
      ORDER BY lp.created_at DESC
      LIMIT 500
    ) s;

  ELSIF p_kind = 'portfolios' THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
               'id', ip.id,
               'portfolio_code', ip.portfolio_code,
               'partner_name', COALESCE(pp.full_name,'Unnamed funder'),
               'partner_phone', pp.phone,
               'amount', COALESCE(ip.investment_amount,0),
               'status', ip.status,
               'duration_months', ip.duration_months,
               'created_at', ip.created_at,
               'maturity_date', ip.maturity_date
             ) AS x
      FROM investor_portfolios ip
      LEFT JOIN profiles pp ON pp.id = ip.investor_id
      WHERE ip.status IN ('active','locked')
      ORDER BY COALESCE(ip.investment_amount,0) DESC
      LIMIT 500
    ) s;

  ELSIF p_kind = 'attached_houses' THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
               'id', psh.id,
               'partner_name', COALESCE(pp.full_name,'Unnamed funder'),
               'landlord_name', COALESCE(ld.name,'No landlord linked'),
               'house_title', COALESCE(NULLIF(hl.title,''),'Untitled house'),
               'district', COALESCE(NULLIF(hl.district,''),'Unspecified'),
               'amount', COALESCE(psh.principal,0),
               'status', psh.status,
               'supported_at', COALESCE(psh.activated_at, psh.supported_at, psh.created_at)
             ) AS x
      FROM partner_supported_houses psh
      LEFT JOIN profiles pp ON pp.id = psh.partner_id
      LEFT JOIN landlords ld ON ld.id = psh.landlord_id
      LEFT JOIN house_listings hl ON hl.id = psh.house_id
      WHERE psh.status <> 'cancelled'
      ORDER BY COALESCE(psh.principal,0) DESC
      LIMIT 500
    ) s;

  ELSE
    RAISE EXCEPTION 'Unknown drilldown kind: %', p_kind;
  END IF;

  RETURN jsonb_build_object('kind', p_kind, 'key', p_key, 'rows', v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_ops_float_drilldown(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landlord_ops_float_drilldown(text, text) TO authenticated;
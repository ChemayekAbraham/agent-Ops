-- Read-only, server-paged geographic breakdown of money paid to landlords, plus a
-- per-payout source-transaction drilldown. Nothing is written; recorded location
-- text is never rewritten and unmatched spellings stay visible under Unmapped.

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
  v_total bigint := 0;
  v_amount numeric := 0;
  v_payouts bigint := 0;
  v_rows jsonb := '[]'::jsonb;
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

  CREATE TEMP TABLE IF NOT EXISTS _lp_geo_page (
    country text, region text, district text,
    payouts bigint, amount numeric, unmatched boolean
  ) ON COMMIT DROP;
  DELETE FROM _lp_geo_page;

  INSERT INTO _lp_geo_page
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
  )
  SELECT country, region, district, COUNT(*), SUM(amount), bool_and(unmatched)
  FROM mapped
  WHERE (v_country IS NULL OR country = v_country)
    AND (v_region IS NULL OR region = v_region)
    AND (v_district IS NULL OR district = v_district)
  GROUP BY country, region, district;

  SELECT COUNT(*), COALESCE(SUM(amount),0), COALESCE(SUM(payouts),0)
  INTO v_total, v_amount, v_payouts
  FROM _lp_geo_page;

  SELECT COALESCE(jsonb_agg(x), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT jsonb_build_object(
             'country', country,
             'region', region,
             'district', district,
             'payouts', payouts,
             'amount', amount,
             'unmatched', unmatched
           ) AS x
    FROM _lp_geo_page
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
  ) s;

  RETURN jsonb_build_object(
    'as_at', now(),
    'rows', v_rows,
    'total_count', v_total,
    'total_amount', v_amount,
    'total_payouts', v_payouts,
    'limit', v_limit,
    'offset', v_offset
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_ops_payouts_geo_page(text, text, date, date, uuid, text, text, text, integer, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landlord_ops_payouts_geo_page(text, text, date, date, uuid, text, text, text, integer, integer, text, text) TO authenticated;

-- Underlying source transactions behind one landlord payout: the recorded payout
-- itself and its posted ledger legs. Strictly read-only.
CREATE OR REPLACE FUNCTION public.landlord_ops_payout_source_transactions(
  p_payout_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_payout jsonb;
  v_legs jsonb := '[]'::jsonb;
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

  SELECT jsonb_build_object(
           'id', lp.id,
           'landlord_name', COALESCE(NULLIF(lp.landlord_name,''), ld.name, 'No landlord linked'),
           'landlord_phone', COALESCE(lp.landlord_phone, ld.phone),
           'tenant_name', tp.full_name,
           'agent_name', ap.full_name,
           'amount', COALESCE(lp.amount,0),
           'status', lp.status,
           'provider', lp.mobile_money_provider,
           'reference', COALESCE(lp.finops_momo_reference, lp.external_reference, lp.receipt_number),
           'disbursed_at', COALESCE(lp.finops_disbursed_at, lp.disbursed_at),
           'created_at', lp.created_at,
           'rent_request_id', lp.rent_request_id
         )
  INTO v_payout
  FROM landlord_payouts lp
  LEFT JOIN landlords ld ON ld.id = lp.landlord_id
  LEFT JOIN profiles tp ON tp.id = lp.tenant_id
  LEFT JOIN profiles ap ON ap.id = lp.agent_id
  WHERE lp.id = p_payout_id;

  IF v_payout IS NULL THEN
    RETURN jsonb_build_object('as_at', now(), 'payout', NULL, 'legs', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'transaction_date')), '[]'::jsonb)
  INTO v_legs
  FROM (
    SELECT jsonb_build_object(
             'id', gl.id,
             'transaction_date', gl.transaction_date,
             'category', gl.category,
             'direction', gl.direction,
             'amount', COALESCE(gl.amount,0),
             'ledger_scope', gl.ledger_scope,
             'classification', gl.classification,
             'account', gl.account,
             'description', gl.description,
             'reference_id', gl.reference_id,
             'linked_party', gl.linked_party
           ) AS x
    FROM general_ledger gl
    WHERE gl.source_id = p_payout_id
       OR gl.reference_id ILIKE '%' || p_payout_id::text || '%'
  ) s;

  RETURN jsonb_build_object('as_at', now(), 'payout', v_payout, 'legs', v_legs);
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_ops_payout_source_transactions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landlord_ops_payout_source_transactions(uuid) TO authenticated;
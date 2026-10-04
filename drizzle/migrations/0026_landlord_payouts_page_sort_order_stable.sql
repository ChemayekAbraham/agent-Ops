-- Keeps the sorted page order intact when the rows are serialised to JSON.
CREATE OR REPLACE FUNCTION public.landlord_ops_payouts_page(
  p_scope text DEFAULT 'all_time',
  p_search text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_sort text DEFAULT 'disbursed_at',
  p_dir text DEFAULT 'desc'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_q text := NULLIF(TRIM(COALESCE(p_search, '')), '');
  v_sort text := LOWER(COALESCE(NULLIF(TRIM(p_sort), ''), 'disbursed_at'));
  v_desc boolean := LOWER(COALESCE(p_dir, 'desc')) <> 'asc';
  v_total bigint := 0;
  v_amount numeric := 0;
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

  IF v_sort NOT IN ('disbursed_at','created_at','amount','landlord_name','tenant_name','agent_name','status','provider','reference') THEN
    v_sort := 'disbursed_at';
  END IF;

  WITH base AS (
    SELECT lp.id,
           COALESCE(NULLIF(lp.landlord_name,''), ld.name, 'No landlord linked') AS landlord_name,
           COALESCE(lp.landlord_phone, ld.phone) AS landlord_phone,
           tp.full_name AS tenant_name,
           ap.full_name AS agent_name,
           COALESCE(lp.amount,0) AS amount,
           lp.mobile_money_provider AS provider,
           COALESCE(lp.finops_momo_reference, lp.external_reference, lp.receipt_number) AS reference,
           lp.status,
           COALESCE(lp.finops_disbursed_at, lp.disbursed_at) AS disbursed_at,
           lp.created_at
    FROM landlord_payouts lp
    LEFT JOIN landlords ld ON ld.id = lp.landlord_id
    LEFT JOIN profiles tp ON tp.id = lp.tenant_id
    LEFT JOIN profiles ap ON ap.id = lp.agent_id
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
  ), totals AS (
    SELECT COUNT(*)::bigint AS n, COALESCE(SUM(amount),0) AS amt FROM base
  ), ordered AS (
    SELECT * FROM base
    ORDER BY
      CASE WHEN v_sort = 'amount' AND v_desc THEN amount END DESC NULLS LAST,
      CASE WHEN v_sort = 'amount' AND NOT v_desc THEN amount END ASC NULLS LAST,
      CASE WHEN v_sort = 'created_at' AND v_desc THEN created_at END DESC NULLS LAST,
      CASE WHEN v_sort = 'created_at' AND NOT v_desc THEN created_at END ASC NULLS LAST,
      CASE WHEN v_sort = 'disbursed_at' AND v_desc THEN COALESCE(disbursed_at, created_at) END DESC NULLS LAST,
      CASE WHEN v_sort = 'disbursed_at' AND NOT v_desc THEN COALESCE(disbursed_at, created_at) END ASC NULLS LAST,
      CASE WHEN v_sort NOT IN ('amount','created_at','disbursed_at') AND v_desc THEN
        LOWER(COALESCE(
          CASE v_sort
            WHEN 'landlord_name' THEN landlord_name
            WHEN 'tenant_name' THEN tenant_name
            WHEN 'agent_name' THEN agent_name
            WHEN 'status' THEN status
            WHEN 'provider' THEN provider
            WHEN 'reference' THEN reference
          END, ''))
      END DESC NULLS LAST,
      CASE WHEN v_sort NOT IN ('amount','created_at','disbursed_at') AND NOT v_desc THEN
        LOWER(COALESCE(
          CASE v_sort
            WHEN 'landlord_name' THEN landlord_name
            WHEN 'tenant_name' THEN tenant_name
            WHEN 'agent_name' THEN agent_name
            WHEN 'status' THEN status
            WHEN 'provider' THEN provider
            WHEN 'reference' THEN reference
          END, ''))
      END ASC NULLS LAST,
      id
    LIMIT v_limit OFFSET v_offset
  ), page AS (
    SELECT o.*, ROW_NUMBER() OVER () AS rn FROM ordered o
  )
  SELECT t.n, t.amt,
         COALESCE((SELECT jsonb_agg(to_jsonb(p) - 'rn' ORDER BY p.rn) FROM page p), '[]'::jsonb)
  INTO v_total, v_amount, v_rows
  FROM totals t;

  RETURN jsonb_build_object(
    'rows', v_rows,
    'total_count', v_total,
    'total_amount', v_amount,
    'limit', v_limit,
    'offset', v_offset,
    'sort', v_sort,
    'dir', CASE WHEN v_desc THEN 'desc' ELSE 'asc' END,
    'as_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_ops_payouts_page(text, text, date, date, uuid, integer, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landlord_ops_payouts_page(text, text, date, date, uuid, integer, integer, text, text) TO authenticated;
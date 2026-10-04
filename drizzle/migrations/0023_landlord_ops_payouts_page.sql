CREATE INDEX IF NOT EXISTS idx_landlord_payouts_disbursed_at_desc
  ON public.landlord_payouts ((COALESCE(finops_disbursed_at, disbursed_at)) DESC)
  WHERE status <> 'failed';

CREATE INDEX IF NOT EXISTS idx_landlord_payouts_created_at_desc
  ON public.landlord_payouts (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_landlord_payouts_agent_id
  ON public.landlord_payouts (agent_id);

CREATE INDEX IF NOT EXISTS idx_landlord_payouts_landlord_name_lower
  ON public.landlord_payouts ((lower(landlord_name)));

CREATE OR REPLACE FUNCTION public.landlord_ops_payouts_page(
  p_scope text DEFAULT 'all_time',
  p_search text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
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
  ), page AS (
    SELECT * FROM base
    ORDER BY COALESCE(disbursed_at, created_at) DESC, id
    LIMIT v_limit OFFSET v_offset
  )
  SELECT t.n, t.amt,
         COALESCE(
           (SELECT jsonb_agg(to_jsonb(p) ORDER BY COALESCE(p.disbursed_at, p.created_at) DESC, p.id)
            FROM page p),
           '[]'::jsonb)
  INTO v_total, v_amount, v_rows
  FROM totals t;

  RETURN jsonb_build_object(
    'rows', v_rows,
    'total_count', v_total,
    'total_amount', v_amount,
    'limit', v_limit,
    'offset', v_offset,
    'as_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_ops_payouts_page(text, text, date, date, uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landlord_ops_payouts_page(text, text, date, date, uuid, integer, integer) TO authenticated;
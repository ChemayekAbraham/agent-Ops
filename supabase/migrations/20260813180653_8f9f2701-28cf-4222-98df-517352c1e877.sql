CREATE OR REPLACE FUNCTION public.partner_self_list_fundable_plans(p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_city text DEFAULT NULL::text, p_min_amount numeric DEFAULT NULL::numeric, p_max_amount numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb;
  v_total integer;
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for self-managed funding' USING ERRCODE = '42501';
  END IF;

  WITH filtered AS (
    SELECT p.*, COUNT(*) OVER () AS total_count
    FROM public.v_partner_self_fundable_plans p
    WHERE (p.held_by IS NULL OR p.held_by = v_uid)
      AND (p_city IS NULL OR p.request_city ILIKE '%' || p_city || '%')
      AND (p_min_amount IS NULL OR p.funding_amount >= p_min_amount)
      AND (p_max_amount IS NULL OR p.funding_amount <= p_max_amount)
    ORDER BY COALESCE(p.approved_at, p.posted_at) DESC NULLS LAST, p.posted_at DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit,20), 100))
    OFFSET GREATEST(0, COALESCE(p_offset,0))
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(f) - 'total_count'), '[]'::jsonb), COALESCE(MAX(f.total_count),0)
  INTO v_rows, v_total
  FROM filtered f;

  RETURN jsonb_build_object(
    'plans', v_rows,
    'total', v_total,
    'available_balance', public.get_user_available_balance(v_uid),
    'hold_minutes', 10
  );
END;
$function$;
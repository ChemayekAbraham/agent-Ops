CREATE OR REPLACE FUNCTION public.finops_payout_decision_log(
  p_limit integer DEFAULT 50,
  p_search text DEFAULT NULL,
  p_decision text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
)
 RETURNS TABLE(id uuid, user_id uuid, full_name text, user_phone text, destination_type text, provider text, momo_number text, bank_name text, bank_account_number text, account_name text, status text, decision_reason text, decided_by_name text, decided_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
BEGIN
  IF auth.uid() IS NULL OR NOT (
    public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  ) THEN
    RAISE EXCEPTION 'Only Financial Ops can view the decision log.';
  END IF;

  IF p_decision IS NOT NULL AND p_decision NOT IN ('verified', 'rejected') THEN
    RAISE EXCEPTION 'Decision filter must be verified or rejected.';
  END IF;

  RETURN QUERY
  SELECT
    v.id,
    v.user_id,
    p.full_name,
    p.phone,
    v.destination_type::text,
    v.provider,
    v.momo_number,
    v.bank_name,
    v.bank_account_number,
    v.account_name,
    v.status,
    v.decision_reason,
    d.full_name,
    v.decided_at
  FROM public.payout_destination_verifications v
  LEFT JOIN public.profiles p ON p.id = v.user_id
  LEFT JOIN public.profiles d ON d.id = v.decided_by
  WHERE v.decided_at IS NOT NULL
    AND (p_decision IS NULL OR v.status = p_decision)
    AND (p_from IS NULL OR v.decided_at >= p_from)
    AND (p_to IS NULL OR v.decided_at < p_to + interval '1 day')
    AND (
      v_search IS NULL
      OR p.full_name ILIKE '%' || v_search || '%'
      OR p.phone ILIKE '%' || v_search || '%'
      OR v.momo_number ILIKE '%' || v_search || '%'
      OR v.bank_account_number ILIKE '%' || v_search || '%'
      OR v.bank_name ILIKE '%' || v_search || '%'
      OR v.account_name ILIKE '%' || v_search || '%'
      OR d.full_name ILIKE '%' || v_search || '%'
    )
  ORDER BY v.decided_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END;
$function$;
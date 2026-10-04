CREATE OR REPLACE FUNCTION public.fin_ops_recent_cash_codes(p_limit integer DEFAULT 50)
 RETURNS TABLE(verification_id uuid, deposit_request_id uuid, depositor_name text, depositor_phone text, amount numeric, code text, status text, attempts integer, max_attempts integer, deposit_purpose text, expires_at timestamp with time zone, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'operations')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  RETURN QUERY
  SELECT
    v.id,
    v.deposit_request_id,
    p.full_name,
    p.phone,
    v.amount,
    CASE
      WHEN v.status = 'verified' THEN NULL
      ELSE v.code_plain
    END AS code,
    v.status,
    v.attempts,
    v.max_attempts,
    dr.deposit_purpose::text,
    v.expires_at,
    v.created_at
  FROM public.cash_deposit_verifications v
  LEFT JOIN public.profiles p ON p.id = v.user_id
  LEFT JOIN public.deposit_requests dr ON dr.id = v.deposit_request_id
  ORDER BY v.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
END;
$function$;
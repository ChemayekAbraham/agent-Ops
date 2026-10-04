ALTER TABLE public.cash_deposit_verifications ADD COLUMN IF NOT EXISTS code_plain text;

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
  WITH latest AS (
    SELECT DISTINCT ON (v.deposit_request_id)
      v.id,
      v.deposit_request_id,
      v.user_id,
      v.amount,
      v.status,
      v.attempts,
      v.max_attempts,
      v.expires_at,
      v.created_at,
      v.code_plain
    FROM public.cash_deposit_verifications v
    ORDER BY v.deposit_request_id, v.created_at DESC
  )
  SELECT
    l.id,
    l.deposit_request_id,
    p.full_name,
    p.phone,
    l.amount,
    l.code_plain AS code,
    l.status,
    l.attempts,
    l.max_attempts,
    dr.deposit_purpose::text,
    l.expires_at,
    l.created_at
  FROM latest l
  LEFT JOIN public.profiles p ON p.id = l.user_id
  LEFT JOIN public.deposit_requests dr ON dr.id = l.deposit_request_id
  ORDER BY l.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
END;
$function$;
-- 1) Store the plaintext code so authorized Financial Ops staff can read it
--    back to the depositor in-app. Crediting STILL requires the depositor to
--    enter the code (hash compare unchanged) — this does not weaken the
--    cash-code credit fortress, it only mirrors what the verifier inbox shows.
ALTER TABLE public.cash_deposit_verifications
  ADD COLUMN IF NOT EXISTS code_plain text;

-- 2) Role-gated, security-definer lookup for the Financial Ops panel.
--    The plaintext code is ONLY revealed while the deposit is still
--    awaiting the code and not yet expired; otherwise it is masked.
CREATE OR REPLACE FUNCTION public.fin_ops_recent_cash_codes(p_limit integer DEFAULT 50)
RETURNS TABLE (
  verification_id uuid,
  deposit_request_id uuid,
  depositor_name text,
  depositor_phone text,
  amount numeric,
  code text,
  status text,
  attempts integer,
  max_attempts integer,
  deposit_purpose text,
  expires_at timestamptz,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
      WHEN v.status = 'awaiting_code' AND v.expires_at > now() THEN v.code_plain
      ELSE NULL
    END AS code,
    v.status,
    v.attempts,
    v.max_attempts,
    dr.deposit_purpose,
    v.expires_at,
    v.created_at
  FROM public.cash_deposit_verifications v
  LEFT JOIN public.profiles p ON p.id = v.user_id
  LEFT JOIN public.deposit_requests dr ON dr.id = v.deposit_request_id
  ORDER BY v.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
END;
$$;

GRANT EXECUTE ON FUNCTION public.fin_ops_recent_cash_codes(integer) TO authenticated;

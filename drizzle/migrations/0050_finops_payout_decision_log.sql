CREATE OR REPLACE FUNCTION public.finops_payout_decision_log(p_limit integer DEFAULT 50)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  full_name text,
  user_phone text,
  destination_type text,
  provider text,
  momo_number text,
  bank_name text,
  bank_account_number text,
  account_name text,
  status text,
  decision_reason text,
  decided_by_name text,
  decided_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (
    public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  ) THEN
    RAISE EXCEPTION 'Only Financial Ops can view the decision log.';
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
  LEFT JOIN public.profiles p ON p.user_id = v.user_id
  LEFT JOIN public.profiles d ON d.user_id = v.decided_by
  WHERE v.decided_at IS NOT NULL
  ORDER BY v.decided_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END;
$$;

GRANT EXECUTE ON FUNCTION public.finops_payout_decision_log(integer) TO authenticated;
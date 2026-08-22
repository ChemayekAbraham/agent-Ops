-- Lending agents look up a borrower by exact phone (last 9 digits), no enumeration
CREATE OR REPLACE FUNCTION public.lending_find_user_by_phone(p_phone text)
RETURNS TABLE (user_id uuid, full_name text, phone text, city text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_digits text;
  v_last9 text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.lending_agent_agreement_acceptance laa
    WHERE laa.agent_user_id = auth.uid() AND laa.status = 'accepted'
  ) THEN
    RAISE EXCEPTION 'lending_agreement_required';
  END IF;

  v_digits := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  IF length(v_digits) < 9 THEN
    RAISE EXCEPTION 'phone_too_short';
  END IF;
  v_last9 := right(v_digits, 9);

  RETURN QUERY
  SELECT p.id, p.full_name, p.phone, p.city
  FROM public.profiles p
  WHERE right(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g'), 9) = v_last9
    AND p.id <> auth.uid()
  LIMIT 5;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lending_find_user_by_phone(text) TO authenticated;

-- Borrower loan portfolio with lender contact details
CREATE OR REPLACE FUNCTION public.get_my_borrowed_loans()
RETURNS TABLE (
  id uuid,
  lender_agent_id uuid,
  lender_name text,
  lender_phone text,
  principal_ugx numeric,
  interest_rate_pct numeric,
  amount_repaid_ugx numeric,
  status text,
  expected_repayment_date date,
  repayment_frequency text,
  installment_ugx numeric,
  next_deduction_date date,
  auto_deduct_enabled boolean,
  loan_purpose text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    l.id,
    l.lender_agent_id,
    lp.full_name,
    lp.phone,
    l.principal_ugx,
    l.interest_rate_pct,
    l.amount_repaid_ugx,
    l.status,
    l.expected_repayment_date,
    l.repayment_frequency,
    l.installment_ugx,
    l.next_deduction_date,
    l.auto_deduct_enabled,
    l.loan_purpose,
    l.created_at
  FROM public.lending_agent_loans l
  LEFT JOIN public.profiles lp ON lp.id = l.lender_agent_id
  WHERE l.borrower_user_id = auth.uid()
  ORDER BY l.created_at DESC
  LIMIT 200;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_borrowed_loans() TO authenticated;
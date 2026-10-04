CREATE OR REPLACE FUNCTION public.get_user_payroll_exempt_available(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payroll_credits numeric := 0;
  v_withdrawn numeric := 0;
  v_is_agent boolean := false;
BEGIN
  IF p_user_id IS NULL THEN RETURN 0; END IF;

  -- Agents (agent-family roles) are NEVER exempt from KYC caps.
  -- Cast to text so we can safely test against role names that may or may not
  -- exist in the app_role enum without raising an invalid-enum-value error.
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_user_id
      AND role::text IN ('agent','senior_agent','sub_agent')
  ) INTO v_is_agent;

  IF v_is_agent THEN
    RETURN 0;
  END IF;

  -- Sum wallet-scope cash_in legs whose ledger transaction group also
  -- contains a payroll_expense platform leg (i.e. money that entered this
  -- user's wallet as payroll).
  SELECT COALESCE(SUM(w.amount), 0) INTO v_payroll_credits
  FROM public.general_ledger w
  WHERE w.user_id = p_user_id
    AND w.ledger_scope = 'wallet'
    AND w.direction = 'cash_in'
    AND EXISTS (
      SELECT 1 FROM public.general_ledger p
      WHERE p.transaction_group_id = w.transaction_group_id
        AND p.category = 'payroll_expense'
    );

  SELECT COALESCE(SUM(amount), 0) INTO v_withdrawn
  FROM public.withdrawal_requests
  WHERE user_id = p_user_id
    AND COALESCE(status,'') NOT IN ('rejected','cancelled','failed');

  RETURN GREATEST(0, v_payroll_credits - v_withdrawn);
END;
$function$;
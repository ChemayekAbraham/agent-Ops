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

  -- Agents (any agent-family role) are NEVER exempt from KYC caps.
  -- Even payroll-tagged credits must respect the daily withdrawal ceiling.
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_user_id
      AND role IN ('agent','senior_agent','sub_agent','merchant_agent','proxy_agent')
  ) INTO v_is_agent;

  IF v_is_agent THEN
    RETURN 0;
  END IF;

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
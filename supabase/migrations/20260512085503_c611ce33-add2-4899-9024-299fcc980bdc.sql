CREATE OR REPLACE FUNCTION public.wallet_route_for_category(p_user_id uuid, p_category text, p_direction text)
 RETURNS TABLE(bucket text, sign integer)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sign int;
  v_is_agent boolean := false;
BEGIN
  IF p_direction IN ('credit','cash_in') THEN
    v_sign := 1;
  ELSIF p_direction IN ('debit','cash_out') THEN
    v_sign := -1;
  ELSE
    RAISE EXCEPTION 'UNSUPPORTED_LEDGER_DIRECTION: %', p_direction;
  END IF;

  IF p_user_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = p_user_id
        AND role = 'agent'
        AND COALESCE(enabled, true) = true
    ) INTO v_is_agent;
  END IF;

  -- Agent credits routed to FLOAT (system_balance_correction REMOVED — it must
  -- not pollute float because CFO balance corrections and daily payroll bonuses
  -- are not float-bucket money. They follow the default → withdrawable route.)
  IF v_is_agent AND v_sign = 1 AND p_category IN (
    'wallet_transfer',
    'cfo_direct_credit',
    'roi_wallet_credit','roi_payout',
    'pool_capital_received','partner_funding',
    'supporter_capital','supporter_rent_fund',
    'manager_credit'
  ) THEN
    RETURN QUERY SELECT 'float'::text, 1;
    RETURN;
  END IF;

  -- Agent debits routed to FLOAT (system_balance_correction REMOVED for same reason)
  IF v_is_agent AND v_sign = -1 AND p_category IN (
    'agent_proxy_investment','coo_proxy_investment',
    'pending_portfolio_topup','proxy_partner_withdrawal',
    'wallet_transfer','rent_payment_for_tenant','rent_obligation',
    'cfo_direct_credit'
  ) THEN
    RETURN QUERY SELECT 'float'::text, -1;
    RETURN;
  END IF;

  RETURN QUERY SELECT * FROM public.wallet_route_for_category(p_category, p_direction);
END;
$function$;
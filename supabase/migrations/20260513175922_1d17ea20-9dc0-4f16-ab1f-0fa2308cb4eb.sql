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

  -- Agent credits routed to FLOAT.
  -- ROI categories REMOVED (2026-05-13): partner returns are supporter income
  -- and must always land in the recipient's withdrawable bucket, even when the
  -- recipient also wears the agent hat. Routing them to float made the money
  -- non-withdrawable and broke proxy partner withdrawals.
  IF v_is_agent AND v_sign = 1 AND p_category IN (
    'wallet_transfer',
    'cfo_direct_credit',
    'pool_capital_received','partner_funding',
    'supporter_capital','supporter_rent_fund',
    'manager_credit'
  ) THEN
    RETURN QUERY SELECT 'float'::text, 1;
    RETURN;
  END IF;

  -- Agent debits routed to FLOAT
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
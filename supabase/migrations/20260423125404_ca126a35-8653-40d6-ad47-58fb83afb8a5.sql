-- Fix: User's own wallet deposits must land in withdrawable, not float, regardless of role.
-- The agent-specific float routing was incorrectly capturing 'wallet_deposit' and 'deposit'
-- (mobile-money / cash deposits the user themself initiated). Those represent the user's own
-- money and must always go to withdrawable. Only platform-originated movements
-- (wallet_transfer, roi_wallet_credit, etc.) remain on the float track for proxy agents.

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
  -- Direction → sign
  IF p_direction IN ('credit','cash_in') THEN
    v_sign := 1;
  ELSIF p_direction IN ('debit','cash_out') THEN
    v_sign := -1;
  ELSE
    RAISE EXCEPTION 'UNSUPPORTED_LEDGER_DIRECTION: %', p_direction;
  END IF;

  -- Is this user an agent?
  IF p_user_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = p_user_id
        AND role = 'agent'
        AND COALESCE(enabled, true) = true
    ) INTO v_is_agent;
  END IF;

  -- ===== AGENT-SPECIFIC ROUTING (credits only) =====
  -- Platform-originated "company money" credits go to FLOAT for agents.
  -- NOTE: 'wallet_deposit' and 'deposit' are intentionally EXCLUDED — those are the user's
  -- own money (mobile money / cash deposits they initiated) and must land in WITHDRAWABLE.
  IF v_is_agent AND v_sign = 1 AND p_category IN (
    'wallet_transfer',
    'cfo_direct_credit','system_balance_correction',
    'roi_wallet_credit','roi_payout',
    'pool_capital_received','partner_funding',
    'supporter_capital','supporter_rent_fund',
    'manager_credit'
  ) THEN
    RETURN QUERY SELECT 'float'::text, 1;
    RETURN;
  END IF;

  -- For agents, debits of these float-purpose categories must come out of FLOAT.
  IF v_is_agent AND v_sign = -1 AND p_category IN (
    'agent_proxy_investment','coo_proxy_investment',
    'pending_portfolio_topup','proxy_partner_withdrawal',
    'wallet_transfer','rent_payment_for_tenant','rent_obligation'
  ) THEN
    RETURN QUERY SELECT 'float'::text, -1;
    RETURN;
  END IF;

  -- ===== Fall through to the original (role-blind) routing =====
  RETURN QUERY SELECT * FROM public.wallet_route_for_category(p_category, p_direction);
END;
$function$;

-- Backfill: Carol (ATUHAIRE CAROLYNE) has 5,420,397 stuck in float that is actually her
-- own deposited money. Move it to withdrawable so she can withdraw it.
DO $$
DECLARE
  v_user_id uuid := 'ae194750-4827-47e8-839e-5e772565138b';
  v_amount  numeric := 5420397;
BEGIN
  -- Set the session flag that allows wallet bucket UPDATEs (enforce_wallet_ledger_only trigger)
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  UPDATE public.wallets
  SET withdrawable_balance = withdrawable_balance + v_amount,
      float_balance        = float_balance - v_amount,
      updated_at           = now()
  WHERE user_id = v_user_id
    AND float_balance >= v_amount;

  PERFORM set_config('wallet.sync_authorized', 'false', true);
END $$;
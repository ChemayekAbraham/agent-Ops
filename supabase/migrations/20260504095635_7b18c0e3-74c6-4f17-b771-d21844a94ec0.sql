CREATE OR REPLACE FUNCTION public.get_agent_float_balance(p_agent_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cached_float numeric;
  v_has_wallet boolean;
  v_total_wallet numeric;
  v_commission numeric;
BEGIN
  IF p_agent_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Trust the wallets cache when present.
  -- `wallets.float_balance` is exclusively maintained by `apply_wallet_movement`
  -- (the sole writer of wallet buckets), so it is the authoritative figure for
  -- "company float available to the agent" — and it is not clipped by any
  -- post-anchor ledger window.
  SELECT w.float_balance, true
  INTO v_cached_float, v_has_wallet
  FROM public.wallets w
  WHERE w.user_id = p_agent_id
  LIMIT 1;

  IF v_has_wallet THEN
    RETURN GREATEST(0, COALESCE(v_cached_float, 0));
  END IF;

  -- Legacy fallback (no wallet row): historical ledger-based computation.
  SELECT COALESCE(SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END), 0)
  INTO v_total_wallet
  FROM public.general_ledger
  WHERE user_id = p_agent_id
    AND ledger_scope = 'wallet';

  SELECT COALESCE(SUM(
    CASE
      WHEN direction IN ('cash_in','credit')
        AND category IN (
          'agent_commission_earned','agent_commission','agent_bonus',
          'referral_bonus','proxy_investment_commission',
          'agent_advance_credit','partner_commission'
        )
      THEN amount
      WHEN direction IN ('cash_out','debit')
        AND category IN (
          'agent_commission_withdrawal','agent_commission_used_for_rent',
          'wallet_withdrawal','wallet_transfer','wallet_deduction',
          'wallet_deduction_general_adjustment'
        )
      THEN -amount
      ELSE 0
    END
  ), 0)
  INTO v_commission
  FROM public.general_ledger
  WHERE user_id = p_agent_id
    AND ledger_scope = 'wallet';

  v_commission := GREATEST(0, v_commission);
  RETURN GREATEST(0, v_total_wallet - v_commission);
END;
$function$;
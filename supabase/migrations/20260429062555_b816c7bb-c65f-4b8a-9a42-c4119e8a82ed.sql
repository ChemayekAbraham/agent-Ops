-- 1) Single source of truth: float balance the allocation RPC will accept
CREATE OR REPLACE FUNCTION public.get_agent_float_balance(p_agent_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_total_wallet numeric;
  v_commission numeric;
BEGIN
  IF p_agent_id IS NULL THEN
    RETURN 0;
  END IF;

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
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_float_balance(uuid) TO authenticated, anon;

-- 2) Backfill agent_landlord_float rows for agents with wallet ledger activity
--    but no row yet, so they can reach the allocation dialog.
INSERT INTO public.agent_landlord_float (agent_id, balance, total_funded, total_paid_out)
SELECT
  ur.user_id,
  public.get_agent_float_balance(ur.user_id),
  0,
  0
FROM public.user_roles ur
WHERE ur.role = 'agent'
  AND NOT EXISTS (
    SELECT 1 FROM public.agent_landlord_float alf WHERE alf.agent_id = ur.user_id
  )
  AND EXISTS (
    SELECT 1 FROM public.general_ledger gl
    WHERE gl.user_id = ur.user_id
      AND gl.ledger_scope = 'wallet'
  );
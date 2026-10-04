
CREATE OR REPLACE FUNCTION public.get_agent_split_balances(p_agent_id uuid)
RETURNS TABLE(float_balance numeric, commission_balance numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total numeric := 0;
  v_commission numeric := 0;
BEGIN
  SELECT COALESCE(
    SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END),
    0
  ) INTO v_total
  FROM general_ledger
  WHERE user_id = p_agent_id
    AND ledger_scope = 'wallet';

  SELECT COALESCE(
    SUM(
      CASE
        WHEN direction IN ('cash_in','credit')
          AND category IN (
            'agent_commission_earned',
            'agent_commission',
            'agent_bonus',
            'referral_bonus',
            'proxy_investment_commission',
            'agent_advance_credit',
            'partner_commission'
          )
        THEN amount
        WHEN direction IN ('cash_out','debit')
          AND category IN (
            'agent_commission_withdrawal',
            'agent_commission_used_for_rent'
          )
        THEN -amount
        ELSE 0
      END
    ),
    0
  ) INTO v_commission
  FROM general_ledger
  WHERE user_id = p_agent_id
    AND ledger_scope = 'wallet';

  RETURN QUERY SELECT GREATEST(0, v_total - v_commission) AS float_balance, v_commission AS commission_balance;
END;
$$;

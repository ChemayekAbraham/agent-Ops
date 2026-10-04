
-- Function to derive split balances from general_ledger
CREATE OR REPLACE FUNCTION public.get_agent_split_balances(p_agent_id UUID)
RETURNS TABLE(float_balance NUMERIC, commission_balance NUMERIC)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    -- FLOAT: deposits minus rent usage
    COALESCE(SUM(CASE
      WHEN category IN ('agent_float_deposit', 'wallet_deposit') AND direction IN ('cash_in', 'credit') THEN amount
      WHEN category IN ('agent_float_used_for_rent', 'rent_payment_for_tenant') AND direction IN ('cash_out', 'debit') THEN -amount
      ELSE 0
    END), 0) AS float_balance,
    -- COMMISSION: earned minus withdrawn/used
    COALESCE(SUM(CASE
      WHEN category IN ('agent_commission_earned', 'agent_commission', 'agent_bonus') AND direction IN ('cash_in', 'credit') THEN amount
      WHEN category IN ('agent_commission_withdrawal', 'agent_commission_used_for_rent', 'tenant_default_charge') AND direction IN ('cash_out', 'debit') THEN -amount
      ELSE 0
    END), 0) AS commission_balance
  FROM general_ledger
  WHERE user_id = p_agent_id;
$$;

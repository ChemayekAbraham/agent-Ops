CREATE OR REPLACE FUNCTION public.get_agent_split_balances(p_agent_id UUID)
RETURNS TABLE(float_balance NUMERIC, commission_balance NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH totals AS (
    SELECT
      COALESCE(SUM(
        CASE
          WHEN direction IN ('credit', 'cash_in') THEN amount
          WHEN direction IN ('debit', 'cash_out') THEN -amount
          ELSE 0
        END
      ), 0) AS total_balance,
      COALESCE(SUM(
        CASE
          WHEN category IN (
            'agent_commission_earned', 'agent_commission',
            'agent_bonus', 'referral_bonus', 'proxy_investment_commission'
          ) AND direction IN ('credit', 'cash_in') THEN amount
          WHEN category IN (
            'agent_commission_withdrawal',
            'agent_commission_used_for_rent',
            'tenant_default_charge'
          ) AND direction IN ('debit', 'cash_out') THEN -amount
          ELSE 0
        END
      ), 0) AS raw_commission_balance
    FROM general_ledger
    WHERE user_id = p_agent_id AND ledger_scope = 'wallet'
  )
  SELECT
    total_balance - GREATEST(0, raw_commission_balance) AS float_balance,
    GREATEST(0, raw_commission_balance) AS commission_balance
  FROM totals;
$$;
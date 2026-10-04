CREATE OR REPLACE FUNCTION public.get_withdrawal_source_breakdown(
  p_user_id uuid,
  p_lookback_days integer DEFAULT 365
)
RETURNS TABLE (
  source_key text,
  source_label text,
  amount numeric,
  txn_count integer,
  pct numeric,
  is_adjustment boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (
    SELECT (auth.uid() = p_user_id
            OR public.is_ops_role(auth.uid())
            OR public.has_role(auth.uid(), 'cfo')
            OR public.has_role(auth.uid(), 'coo')
            OR public.has_role(auth.uid(), 'ceo')
            OR public.has_role(auth.uid(), 'manager')
            OR public.has_role(auth.uid(), 'super_admin')) AS ok
  ),
  legs AS (
    SELECT
      CASE
        WHEN gl.category IN ('agent_commission','agent_commission_earned','proxy_investment_commission','agent_investment_commission') THEN 'commission'
        WHEN gl.category IN ('wallet_deposit','deposit','partner_funding','supporter_capital','agent_float_deposit') THEN 'deposit'
        WHEN gl.category IN ('wallet_transfer','account_merge') THEN 'transfer_in'
        WHEN gl.category IN ('referral_bonus') THEN 'referral'
        WHEN gl.category IN ('roi_wallet_credit','roi_payout','roi_reinvestment') THEN 'returns'
        WHEN gl.category IN ('agent_bonus','listing_rejection_offset','agent_incentive_bonus') THEN 'bonus'
        WHEN gl.category IN ('rent_repayment','tenant_repayment','agent_repayment','rent_principal_collected','landlord_rent_payment') THEN 'collections'
        WHEN gl.category IN ('agent_advance_credit') THEN 'advance'
        WHEN gl.classification = 'admin_correction'
          OR gl.category IN ('system_balance_correction','historical_balance_reseed','balance_correction','correction_reversal','reconciliation','manager_credit','test_funds_cleanup') THEN 'adjustment'
        ELSE 'other'
      END AS source_key,
      gl.amount
    FROM public.general_ledger gl, guard
    WHERE guard.ok
      AND gl.user_id = p_user_id
      AND gl.ledger_scope = 'wallet'
      AND gl.direction = 'cash_in'
      AND COALESCE(gl.wallet_bucket, 'withdrawable') = 'withdrawable'
      AND gl.created_at >= now() - make_interval(days => GREATEST(p_lookback_days, 1))
  ),
  agg AS (
    SELECT source_key, SUM(amount) AS amount, COUNT(*)::int AS txn_count
    FROM legs
    GROUP BY source_key
  ),
  tot AS (SELECT NULLIF(SUM(amount), 0) AS total FROM agg)
  SELECT
    a.source_key,
    CASE a.source_key
      WHEN 'commission' THEN 'Commission'
      WHEN 'deposit' THEN 'Deposit'
      WHEN 'transfer_in' THEN 'Wallet transfer in'
      WHEN 'referral' THEN 'Referral'
      WHEN 'returns' THEN 'Returns'
      WHEN 'bonus' THEN 'Bonus'
      WHEN 'collections' THEN 'Collections'
      WHEN 'advance' THEN 'Advance credit'
      WHEN 'adjustment' THEN 'Admin adjustment'
      ELSE 'Other'
    END AS source_label,
    a.amount,
    a.txn_count,
    ROUND((a.amount / t.total) * 100, 1) AS pct,
    (a.source_key = 'adjustment') AS is_adjustment
  FROM agg a CROSS JOIN tot t
  ORDER BY a.amount DESC;
$$;

REVOKE ALL ON FUNCTION public.get_withdrawal_source_breakdown(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_withdrawal_source_breakdown(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_withdrawal_source_breakdown(uuid, integer) TO service_role;
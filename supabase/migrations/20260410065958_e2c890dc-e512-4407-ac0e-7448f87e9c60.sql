
-- Part 1: Create the RPC function for accurate integrity checks
CREATE OR REPLACE FUNCTION public.get_ledger_integrity_checks()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_drift_count int;
  v_negative_count int;
  v_missing_group_count int;
BEGIN
  -- Count wallet/ledger drift: users where wallet.balance != ledger-derived balance
  SELECT count(*) INTO v_drift_count
  FROM (
    SELECT gl.user_id,
           COALESCE(SUM(CASE WHEN gl.direction = 'cash_in' THEN gl.amount ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN gl.direction = 'cash_out' THEN gl.amount ELSE 0 END), 0) AS ledger_balance
    FROM general_ledger gl
    WHERE gl.scope = 'wallet' AND gl.user_id IS NOT NULL
    GROUP BY gl.user_id
  ) lb
  JOIN wallets w ON w.user_id = lb.user_id
  WHERE ROUND(w.balance::numeric, 2) != ROUND(lb.ledger_balance::numeric, 2);

  -- Count users with negative ledger-derived balances
  SELECT count(*) INTO v_negative_count
  FROM (
    SELECT gl.user_id,
           COALESCE(SUM(CASE WHEN gl.direction = 'cash_in' THEN gl.amount ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN gl.direction = 'cash_out' THEN gl.amount ELSE 0 END), 0) AS ledger_balance
    FROM general_ledger gl
    WHERE gl.scope = 'wallet' AND gl.user_id IS NOT NULL
    GROUP BY gl.user_id
  ) lb
  WHERE lb.ledger_balance < -0.01;

  -- Count entries missing transaction_group_id
  SELECT count(*) INTO v_missing_group_count
  FROM general_ledger
  WHERE transaction_group_id IS NULL;

  RETURN jsonb_build_object(
    'wallet_drift_count', v_drift_count,
    'negative_balance_count', v_negative_count,
    'missing_group_count', v_missing_group_count
  );
END;
$$;

-- Grant access to authenticated users (executive roles have RLS SELECT on general_ledger)
GRANT EXECUTE ON FUNCTION public.get_ledger_integrity_checks() TO authenticated;

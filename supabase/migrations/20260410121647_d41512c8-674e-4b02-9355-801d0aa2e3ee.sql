CREATE OR REPLACE FUNCTION public.get_wallet_reconciliation()
RETURNS TABLE(
  user_id uuid,
  user_name text,
  wallet_balance numeric,
  ledger_balance numeric,
  discrepancy numeric
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    w.user_id,
    COALESCE(p.full_name, 'Unknown') AS user_name,
    w.balance AS wallet_balance,
    COALESCE(lb.ledger_balance, 0) AS ledger_balance,
    ROUND((w.balance - COALESCE(lb.ledger_balance, 0))::numeric, 2) AS discrepancy
  FROM wallets w
  LEFT JOIN profiles p ON p.id = w.user_id
  LEFT JOIN (
    SELECT gl.user_id,
           SUM(CASE WHEN gl.direction = 'cash_in' THEN gl.amount ELSE 0 END)
           - SUM(CASE WHEN gl.direction = 'cash_out' THEN gl.amount ELSE 0 END) AS ledger_balance
    FROM general_ledger gl
    WHERE gl.ledger_scope = 'wallet' AND gl.user_id IS NOT NULL
    GROUP BY gl.user_id
  ) lb ON lb.user_id = w.user_id
  ORDER BY ABS(w.balance - COALESCE(lb.ledger_balance, 0)) DESC;
$$;
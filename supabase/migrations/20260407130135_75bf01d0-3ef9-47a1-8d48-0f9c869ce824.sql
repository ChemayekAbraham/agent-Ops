-- Force resync wallet for LUKODDA JOSEPH based on current ledger state
UPDATE wallets
SET balance = (
  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END), 0)
  FROM general_ledger
  WHERE user_id = 'b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c'
  AND ledger_scope = 'wallet'
),
updated_at = now()
WHERE user_id = 'b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c';
DO $$
BEGIN
  PERFORM set_config('ledger.authorized', 'true', true);
  WITH net AS (
    SELECT user_id,
           SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END) AS bal
    FROM general_ledger
    GROUP BY user_id
    HAVING SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END) < 0
  )
  INSERT INTO general_ledger (user_id, amount, direction, category, reference_id, created_at, description, classification, source_table)
  SELECT n.user_id, ABS(n.bal), 'cash_in', 'system_balance_correction', gen_random_uuid(), now(),
         'System maintenance: negative balance wipe (pass 3, incl NULL bucket)', 'admin_correction', 'manual_admin_action'
  FROM net n;
END $$;
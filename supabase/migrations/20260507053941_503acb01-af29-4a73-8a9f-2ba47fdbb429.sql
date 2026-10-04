DO $$
BEGIN
  PERFORM set_config('ledger.authorized', 'true', true);
  WITH net AS (
    SELECT user_id,
           SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END) AS bal
    FROM general_ledger
    WHERE category <> 'admin_correction'
      AND category <> 'system_balance_correction'
      AND user_id IS NOT NULL
    GROUP BY user_id
  )
  INSERT INTO general_ledger (user_id, amount, direction, category, reference_id, created_at, description, classification, source_table)
  SELECT n.user_id, ABS(n.bal), 'cash_in', 'system_balance_correction', gen_random_uuid(), now(),
         'System maintenance: negative balance wipe', 'admin_correction', 'manual_admin_action'
  FROM net n
  WHERE n.bal < 0;
END $$;
DO $$
BEGIN
  PERFORM set_config('ledger.authorized', 'true', true);
  WITH net AS (
    SELECT user_id,
           SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END) AS bal
    FROM general_ledger
    WHERE user_id IN (
      '2470c782-4248-40b2-a5b9-d7acc84b82b3',
      'c23b362c-14d4-49a7-b727-4b66553aea3a',
      '24fbb61a-04d0-48e6-a496-e902b8e21919',
      '2d742dfa-7ef6-492b-a516-f35ce25ca5a4',
      'dc5ba4af-cb53-4fe8-9aa5-b1b73d0402aa'
    )
    GROUP BY user_id
  )
  INSERT INTO general_ledger (user_id, amount, direction, category, reference_id, created_at, description, classification, source_table)
  SELECT n.user_id, ABS(n.bal), 'cash_in', 'system_balance_correction', gen_random_uuid(), now(),
         'System maintenance: negative balance wipe (pass 2)', 'admin_correction', 'manual_admin_action'
  FROM net n
  WHERE n.bal < 0;
END $$;
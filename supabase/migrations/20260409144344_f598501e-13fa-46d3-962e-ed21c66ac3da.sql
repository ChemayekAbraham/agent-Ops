
DO $$
DECLARE
  rec RECORD;
  correction_amount NUMERIC;
  group_id UUID;
BEGIN
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_sync_wallet_from_ledger;

  FOR rec IN 
    SELECT gl.user_id,
      SUM(CASE WHEN gl.direction = 'cash_in' THEN gl.amount WHEN gl.direction = 'cash_out' THEN -gl.amount END) AS balance
    FROM general_ledger gl
    WHERE gl.ledger_scope = 'wallet' AND gl.user_id IS NOT NULL
    GROUP BY gl.user_id
    HAVING SUM(CASE WHEN gl.direction = 'cash_in' THEN gl.amount WHEN gl.direction = 'cash_out' THEN -gl.amount END) < 0
  LOOP
    correction_amount := ABS(rec.balance);
    group_id := gen_random_uuid();

    INSERT INTO public.general_ledger (transaction_group_id, user_id, ledger_scope, direction, amount, category, source_table, created_at)
    VALUES (group_id, rec.user_id, 'wallet', 'cash_in', correction_amount, 'system_balance_correction', 'system', NOW());

    INSERT INTO public.general_ledger (transaction_group_id, user_id, ledger_scope, direction, amount, category, source_table, created_at)
    VALUES (group_id, NULL, 'platform', 'cash_out', correction_amount, 'system_balance_correction', 'system', NOW());

    RAISE NOTICE 'Fixed orphaned user % | Amount: %', rec.user_id, correction_amount;
  END LOOP;

  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_sync_wallet_from_ledger;
END $$;

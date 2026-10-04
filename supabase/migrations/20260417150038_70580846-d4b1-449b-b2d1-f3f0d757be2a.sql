ALTER TABLE general_ledger DISABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE general_ledger DISABLE TRIGGER trg_auto_ledger_scope;

DO $$
DECLARE
  v_rows_affected INTEGER;
  v_total_amount NUMERIC;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(amount), 0)
  INTO v_rows_affected, v_total_amount
  FROM general_ledger
  WHERE ledger_scope = 'wallet'
    AND user_id IS NULL
    AND source_table = 'system'
    AND created_at BETWEEN '2026-04-09 14:41:00' AND '2026-04-09 14:43:59';

  RAISE NOTICE 'Re-scoping % rows totaling % UGX', v_rows_affected, v_total_amount;

  UPDATE general_ledger
  SET ledger_scope = 'platform'
  WHERE ledger_scope = 'wallet'
    AND user_id IS NULL
    AND source_table = 'system'
    AND created_at BETWEEN '2026-04-09 14:41:00' AND '2026-04-09 14:43:59';

  INSERT INTO audit_logs (action_type, table_name, metadata)
  VALUES (
    'ledger_rescope',
    'general_ledger',
    jsonb_build_object(
      'reason', 'recovery_counter_entries_rescope',
      'rows_affected', v_rows_affected,
      'total_amount', v_total_amount,
      'old_scope', 'wallet',
      'new_scope', 'platform',
      'filter', 'source_table=system AND created_at IN [2026-04-09 14:41:00, 2026-04-09 14:43:59]',
      'context', 'Apr-9 phantom-balance recovery: platform-side counter-legs were mis-scoped as wallet',
      'guards_lifted', ARRAY['trg_prevent_ledger_update', 'trg_auto_ledger_scope']
    )
  );
END $$;

ALTER TABLE general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE general_ledger ENABLE TRIGGER trg_auto_ledger_scope;
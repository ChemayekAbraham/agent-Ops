ALTER TABLE general_ledger DISABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE general_ledger DISABLE TRIGGER trg_auto_ledger_scope;

DO $$
DECLARE
  v_rows_affected INTEGER;
  v_total_in NUMERIC;
  v_total_out NUMERIC;
BEGIN
  SELECT COUNT(*),
         COALESCE(SUM(amount) FILTER (WHERE direction='cash_in'), 0),
         COALESCE(SUM(amount) FILTER (WHERE direction='cash_out'), 0)
  INTO v_rows_affected, v_total_in, v_total_out
  FROM general_ledger
  WHERE ledger_scope = 'wallet' AND user_id IS NULL;

  RAISE NOTICE 'Re-scoping % rows (cash_in: %, cash_out: %)', v_rows_affected, v_total_in, v_total_out;

  IF v_rows_affected <> 25 THEN
    RAISE EXCEPTION 'Expected exactly 25 rows, found %. Aborting.', v_rows_affected;
  END IF;

  UPDATE general_ledger
  SET ledger_scope = 'platform'
  WHERE ledger_scope = 'wallet' AND user_id IS NULL;

  INSERT INTO audit_logs (action_type, table_name, metadata)
  VALUES (
    'ledger_rescope',
    'general_ledger',
    jsonb_build_object(
      'reason', 'legacy_platform_contra_legs_rescope',
      'rows_affected', v_rows_affected,
      'cash_in_total', v_total_in,
      'cash_out_total', v_total_out,
      'old_scope', 'wallet',
      'new_scope', 'platform',
      'context', 'Phase 2 of recovery: legacy platform-side counter-legs (roi_expense, pool_capital_received, agent_repayment, wallet_deposit/withdrawal backfills, agent_commission_earned). Each individually verified as paired with a real user-side leg in same transaction_group_id.',
      'guards_lifted', ARRAY['trg_prevent_ledger_update', 'trg_auto_ledger_scope']
    )
  );
END $$;

ALTER TABLE general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE general_ledger ENABLE TRIGGER trg_auto_ledger_scope;
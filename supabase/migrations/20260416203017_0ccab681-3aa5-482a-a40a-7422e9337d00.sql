DO $$
DECLARE
  v_op RECORD;
  v_agent_id uuid := 'ae194750-4827-47e8-839e-5e772565138b';
  v_total numeric := 0;
  v_count int := 0;
BEGIN
  FOR v_op IN
    SELECT id, source_id, user_id AS partner_id, amount,
           metadata->>'portfolio_code' AS code
    FROM public.pending_wallet_operations
    WHERE operation_type = 'portfolio_topup'
      AND metadata->>'source_wallet_user_id' = v_agent_id::text
      AND created_at >= '2026-04-16 13:00:00+00'
      AND created_at <= '2026-04-16 14:00:00+00'
      AND NOT EXISTS (
        SELECT 1 FROM public.general_ledger gl
        WHERE gl.user_id = v_agent_id
          AND gl.source_id = pending_wallet_operations.source_id
          AND gl.category = 'wallet_deduction'
          AND gl.amount = pending_wallet_operations.amount
      )
    ORDER BY created_at
  LOOP
    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_agent_id,
          'amount', v_op.amount,
          'direction', 'cash_out',
          'category', 'wallet_deduction',
          'description', format('Reconciliation: missed deduction for %s top-up', v_op.code),
          'source_table', 'investor_portfolios',
          'source_id', v_op.source_id,
          'linked_party', 'platform'
        ),
        jsonb_build_object(
          'user_id', v_op.partner_id,
          'amount', v_op.amount,
          'direction', 'cash_in',
          'category', 'pending_portfolio_topup',
          'description', format('Reconciliation: pending capital for %s', v_op.code),
          'source_table', 'investor_portfolios',
          'source_id', v_op.source_id,
          'linked_party', v_agent_id::text
        )
      )
    );
    v_total := v_total + v_op.amount;
    v_count := v_count + 1;
  END LOOP;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_agent_id,
    'reconciliation_backfill_leaked_topups',
    'wallets',
    v_agent_id,
    jsonb_build_object(
      'reason', 'Edge function used invalid ledger category portfolio_topup_deduction (not in strict allowlist) + stringified entries arg, causing 8 deductions to silently fail. Backfilled with category wallet_deduction.',
      'agent_id', v_agent_id,
      'ops_reconciled', v_count,
      'total_deducted', v_total,
      'window_start', '2026-04-16T13:00:00Z',
      'window_end', '2026-04-16T14:00:00Z'
    )
  );

  RAISE NOTICE 'Reconciled % top-ups, total UGX %', v_count, v_total;
END $$;
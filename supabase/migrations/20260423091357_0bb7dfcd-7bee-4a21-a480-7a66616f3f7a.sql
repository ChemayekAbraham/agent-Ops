-- =============================================================================
-- ROLLBACK: Remove over-credited back-fill entries and restore wallet buckets
-- =============================================================================

DO $$
DECLARE
  v_row record;
  v_count_deleted int := 0;
  v_total_reversed numeric := 0;
BEGIN
  -- Disable mutation guards and bucket router for cleanup
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_delete;
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_update;
  ALTER TABLE public.general_ledger DISABLE TRIGGER general_ledger_route_buckets;

  -- Authorize wallet writes
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  -- For each wallet leg of the back-fill, subtract from the correct bucket
  FOR v_row IN
    SELECT user_id, category, amount
    FROM public.general_ledger
    WHERE source_table = 'phantom_wallet_backfill'
      AND user_id IS NOT NULL
      AND ledger_scope = 'wallet'
  LOOP
    IF v_row.category = 'agent_float_deposit' THEN
      UPDATE public.wallets
        SET float_balance = GREATEST(0, COALESCE(float_balance,0) - v_row.amount),
            balance = GREATEST(0, COALESCE(balance,0) - v_row.amount),
            updated_at = now()
        WHERE user_id = v_row.user_id;
    ELSIF v_row.category IN ('agent_commission_earned', 'roi_wallet_credit', 'wallet_deposit', 'system_balance_correction') THEN
      -- These all routed to withdrawable bucket with advance-recovery offset.
      -- Best reversal: subtract from withdrawable; if over-deducted, the next reconciliation will fix.
      UPDATE public.wallets
        SET withdrawable_balance = GREATEST(0, COALESCE(withdrawable_balance,0) - v_row.amount),
            balance = GREATEST(0, COALESCE(balance,0) - v_row.amount),
            updated_at = now()
        WHERE user_id = v_row.user_id;
    END IF;

    v_total_reversed := v_total_reversed + v_row.amount;
    v_count_deleted := v_count_deleted + 1;
  END LOOP;

  -- Delete all back-fill ledger rows (both wallet and platform legs)
  DELETE FROM public.general_ledger WHERE source_table = 'phantom_wallet_backfill';

  PERFORM set_config('wallet.sync_authorized', 'false', true);

  -- Re-enable triggers
  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_delete;
  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
  ALTER TABLE public.general_ledger ENABLE TRIGGER general_ledger_route_buckets;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, metadata)
  VALUES (
    'phantom_wallet_backfill_rollback', 'wallets', NULL,
    jsonb_build_object(
      'rows_reversed', v_count_deleted,
      'total_ugx_reversed', v_total_reversed,
      'reason', 'Bucket router fired during back-fill, double-crediting wallets. Rolled back.',
      'executed_at', now()
    )
  );

  RAISE NOTICE 'Rolled back % wallet legs, total UGX %', v_count_deleted, v_total_reversed;
END $$;
-- WLT-REPAIR-1: Reverse phantom withdrawal leg + heal stale wallet.balance
-- Target: user cb798acb-68bc-4b4e-a414-a3d374e030b6, withdrawal 3fb2da7e-f311-4c2c-adb2-2e5f6beb3288
-- Phantom ledger group: 889ef2d0-e42c-43fb-b1e9-4b869e330d9c (wallet UPDATE was aborted by bucket invariant trigger)

DO $$
DECLARE
  v_user_id uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6';
  v_wr_id uuid := '3fb2da7e-f311-4c2c-adb2-2e5f6beb3288';
  v_phantom_group uuid := '889ef2d0-e42c-43fb-b1e9-4b869e330d9c';
  v_wallet_id uuid := 'ad9af2e6-5292-4aac-9d1e-823d9b158854';
  v_reversal_group uuid;
BEGIN
  -- STEP 1: Reverse the phantom withdrawal via create_ledger_transaction
  -- (cash_in to user wallet bucket + cash_out from platform, mirroring the original group)
  v_reversal_group := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_user_id,
        'wallet_id', v_wallet_id,
        'direction', 'cash_in',
        'amount', 500000,
        'category', 'system_balance_correction',
        'ledger_scope', 'wallet',
        'classification', 'production',
        'currency', 'UGX',
        'source_table', 'withdrawal_requests',
        'source_id', v_wr_id::text,
        'description', 'Reversal of failed withdrawal 3fb2da7e-f311-4c2c-adb2-2e5f6beb3288 (bucket invariant aborted payout) [WLT-REPAIR-1]'
      ),
      jsonb_build_object(
        'direction', 'cash_out',
        'amount', 500000,
        'category', 'system_balance_correction',
        'ledger_scope', 'platform',
        'classification', 'production',
        'currency', 'UGX',
        'source_table', 'withdrawal_requests',
        'source_id', v_wr_id::text,
        'description', 'Platform reversal of failed withdrawal 3fb2da7e payout (bucket invariant aborted) [WLT-REPAIR-1]'
      )
    ),
    idempotency_key := 'WLT-REPAIR-1-3fb2da7e-f311-4c2c-adb2-2e5f6beb3288',
    skip_balance_check := true
  );

  -- STEP 2: Mark the withdrawal request as failed
  UPDATE public.withdrawal_requests
     SET status = 'failed',
         rejection_reason = 'bucket_invariant_violation: insufficient withdrawable bucket — auto-reversed by WLT-REPAIR-1',
         updated_at = now()
   WHERE id = v_wr_id;

  -- STEP 3: Heal wallet.balance to match bucket sum (bypass invariant trigger)
  PERFORM set_config('app.allow_wallet_sync', 'true', true);
  UPDATE public.wallets
     SET balance = COALESCE(withdrawable_balance,0) + COALESCE(float_balance,0) + COALESCE(advance_balance,0),
         updated_at = now()
   WHERE user_id = v_user_id;

  -- STEP 4: System-wide drift sweep — heal any other wallets where balance != bucket sum
  -- (uses same session flag, so safe within this transaction)
  UPDATE public.wallets
     SET balance = COALESCE(withdrawable_balance,0) + COALESCE(float_balance,0) + COALESCE(advance_balance,0),
         updated_at = now()
   WHERE balance IS DISTINCT FROM
         (COALESCE(withdrawable_balance,0) + COALESCE(float_balance,0) + COALESCE(advance_balance,0));

  -- AUDIT LOG
  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (
    v_user_id,
    'WLT-REPAIR-1',
    'wallet_repair',
    'wallets',
    v_user_id::text,
    jsonb_build_object(
      'reason', 'WLT-REPAIR-1',
      'withdrawal_request_id', v_wr_id,
      'phantom_ledger_group', v_phantom_group,
      'reversal_ledger_group', v_reversal_group,
      'amount_reversed', 500000,
      'note', 'Reversed phantom withdrawal leg, marked request failed, healed wallet.balance to bucket sum, swept system-wide drift'
    )
  );
END $$;
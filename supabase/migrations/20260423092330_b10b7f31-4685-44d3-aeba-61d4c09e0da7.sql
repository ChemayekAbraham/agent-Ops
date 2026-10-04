DO $$
DECLARE
  v_user_id uuid := 'b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c';
  v_old_balance numeric;
  v_old_withdrawable numeric;
BEGIN
  SELECT balance, withdrawable_balance
    INTO v_old_balance, v_old_withdrawable
  FROM public.wallets
  WHERE user_id = v_user_id;

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  UPDATE public.wallets
  SET balance              = 35000000,
      withdrawable_balance = 35000000,
      float_balance        = 0,
      advance_balance      = 0,
      updated_at           = now()
  WHERE user_id = v_user_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_user_id,
    'phantom_balance_reconciliation',
    'wallets',
    v_user_id::text,
    jsonb_build_object(
      'subject', 'LUKODDA JOSEPH',
      'previous_wallet_balance', v_old_balance,
      'previous_withdrawable', v_old_withdrawable,
      'new_wallet_balance', 35000000,
      'new_withdrawable', 35000000,
      'phantom_amount_removed', COALESCE(v_old_balance, 0) - 35000000,
      'real_ledger_balance', 35000000,
      'reason', 'Wallet balance was inflated above real ledger activity by phantom admin_correction / system_balance_correction credits. Reconciled to ledger truth on CFO directive.',
      'authorized_by', 'CFO directive 2026-04-23'
    )
  );

  RAISE NOTICE 'LUKODDA reconciled: was %, now 35000000 (removed % phantom)', v_old_balance, v_old_balance - 35000000;
END $$;
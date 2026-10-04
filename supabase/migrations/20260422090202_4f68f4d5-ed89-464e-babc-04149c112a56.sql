DO $$
BEGIN
  -- Authorize bucket sync bypass
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  UPDATE public.wallets
     SET balance = 392000,
         withdrawable_balance = 392000,
         float_balance = 0,
         advance_balance = 0,
         updated_at = now()
   WHERE user_id = 'b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c';

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    NULL,
    'wallet_force_sync_to_ledger_truth',
    'wallets',
    '24562f3b-dcbb-4ddb-bf73-440c86d7631c',
    jsonb_build_object(
      'reason', 'LUKODDA JOSEPH proxy wallet forced to UGX 392,000 to match ledger truth. After portfolio WIP2604224640 funded UGX 1M from his wallet, expected balance was 392,000 (392k pre-topup + 1M manager correction - 1M portfolio funding). Five subsequent balanced wallet_transfer retry pairs between 08:51-08:58 had their cash_in legs mirrored to wallets.balance by the ledger trigger but cash_out legs were not, inflating wallet to 1,992,000. recompute_wallet_buckets returned 1,392,000 due to historical negative-balance clamping that masked early agent_proxy_investment debits. Wallet directly forced to ledger truth.',
      'wallet_user_id', 'b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c',
      'wallet_id', '24562f3b-dcbb-4ddb-bf73-440c86d7631c',
      'before_balance', 1992000,
      'before_withdrawable', 1392000,
      'after_balance', 392000,
      'after_withdrawable', 392000,
      'ledger_truth', 392000,
      'patched_at', now()
    )
  );
END $$;
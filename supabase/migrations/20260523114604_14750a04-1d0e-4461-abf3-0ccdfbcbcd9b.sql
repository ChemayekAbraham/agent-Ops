DO $$
DECLARE v_tx uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('wallet.sync_authorized','true',true);
  PERFORM create_ledger_transaction(
    p_transaction_group_id := v_tx,
    p_entries := jsonb_build_array(
      jsonb_build_object(
        'user_id','9bb21b14-cf97-428d-960a-abdd244e80b8',
        'amount',35000,
        'direction','cash_in',
        'category','agent_float_deposit',
        'description','Restore UGX 35,000 float to Muwanguzi Fred (0708778540) — re-credit per CFO directive following 21-May Ayebazibwe deposit chain reversal that incorrectly debited his existing float.',
        'ledger_scope','wallet',
        'wallet_bucket','float',
        'classification','production',
        'recipient_type','operational_wallet'
      ),
      jsonb_build_object(
        'user_id', null,
        'amount',35000,
        'direction','cash_out',
        'category','agent_float_deposit',
        'description','Platform funds UGX 35,000 float re-credit to Muwanguzi Fred (CFO-authorized restoration)',
        'ledger_scope','platform',
        'classification','production'
      )
    ),
    p_idempotency_key := 'restore-35k-muwanguzi-float-production-' || v_tx::text,
    p_skip_balance_check := true
  );
END $$;
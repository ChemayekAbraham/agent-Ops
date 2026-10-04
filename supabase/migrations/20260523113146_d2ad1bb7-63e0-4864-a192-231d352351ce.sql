DO $$
DECLARE
  v_tx uuid := gen_random_uuid();
BEGIN
  PERFORM create_ledger_transaction(
    p_transaction_group_id := v_tx,
    p_entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', '9bb21b14-cf97-428d-960a-abdd244e80b8',
        'amount', 35000,
        'direction', 'cash_out',
        'category', 'system_balance_correction',
        'description', 'Reversal of 21-May airtel float deposit (originally credited Ayebazibwe, swept to Muwanguzi 23-May)',
        'ledger_scope', 'wallet',
        'wallet_bucket', 'float',
        'classification', 'admin_correction'
      ),
      jsonb_build_object(
        'user_id', null,
        'amount', 35000,
        'direction', 'cash_in',
        'category', 'system_balance_correction',
        'description', 'Platform recovers reversed airtel float deposit (21-May Ayebazibwe → 23-May Muwanguzi sweep)',
        'ledger_scope', 'platform',
        'classification', 'admin_correction'
      )
    ),
    p_idempotency_key := 'reverse-21may-ayebazibwe-float-via-muwanguzi-' || v_tx::text
  );
END $$;
DO $$
DECLARE
  v_user uuid := '16d52ad2-92e0-4348-af46-17612afa4d49';
  v_amt numeric := 20000;
  v_ref text := 'KATONGOLE-FLOAT-FIX-40829039369';
  v_txn uuid;
  v_reason text := 'Mis-routed deposit fix: Gmail-imported duplicate (deposit_purpose=other) survived dedup and auto-credited withdrawable, while agent submission tagged operational_float was cancelled. Moving 20000 UGX withdrawable->float to match agent intent.';
BEGIN
  SELECT public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_user,
        'amount', v_amt,
        'direction', 'cash_out',
        'category', 'system_balance_correction',
        'ledger_scope', 'wallet',
        'recipient_type', 'user',
        'description', 'Correction: move mis-routed deposit withdrawable -> float (TID MP40829039369, dep 5b81f696)',
        'currency', 'UGX',
        'source_table', 'deposit_requests',
        'reference_id', v_ref,
        'linked_party', 'platform',
        'classification', 'admin_correction'
      ),
      jsonb_build_object(
        'user_id', v_user,
        'amount', v_amt,
        'direction', 'cash_in',
        'category', 'agent_float_deposit',
        'ledger_scope', 'wallet',
        'recipient_type', 'operational_wallet',
        'description', 'Correction: restore operational float (agent tagged operational_float on TID MP40829039369)',
        'currency', 'UGX',
        'source_table', 'deposit_requests',
        'reference_id', v_ref,
        'linked_party', 'platform',
        'classification', 'admin_correction'
      )
    ),
    skip_balance_check := true
  ) INTO v_txn;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  VALUES (
    v_user,
    'wallet_bucket_correction',
    'general_ledger',
    '5b81f696-3a2a-4c71-a507-d421206f5e40',
    v_reason,
    jsonb_build_object(
      'amount', v_amt,
      'from_bucket', 'withdrawable',
      'to_bucket', 'float',
      'original_tid', 'MP40829039369',
      'surviving_deposit_id', '5b81f696-3a2a-4c71-a507-d421206f5e40',
      'cancelled_agent_submission_id', '89e4797e-95f2-403f-9add-0b53ee6294c5',
      'txn_group_id', v_txn,
      'reason', v_reason
    )
  );
END $$;
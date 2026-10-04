DO $$
DECLARE
  v_user uuid := 'ebf0897b-dfdf-4403-ad5c-1c988c72e67c';
  v_raw numeric;
  v_group uuid := gen_random_uuid();
BEGIN
  SELECT (get_user_wallet_view(v_user) ->> 'withdrawable_raw')::numeric INTO v_raw;

  INSERT INTO wallet_fresh_start_anchors (
    user_id, anchor_at, pre_anchor_ledger_net, reason, notes
  ) VALUES (
    v_user, now(), COALESCE(v_raw, 0), 'operator_reset',
    'Manager reset: legitimate KANUNA KEITH rejection net-refund (UGX 30,000) absorbed by historical overdrawn position. Anchoring so owed refund becomes visible.'
  )
  ON CONFLICT (user_id) DO UPDATE
    SET anchor_at = EXCLUDED.anchor_at,
        pre_anchor_ledger_net = EXCLUDED.pre_anchor_ledger_net,
        reason = EXCLUDED.reason,
        notes = EXCLUDED.notes;

  PERFORM create_ledger_transaction(
    p_transaction_group_id := v_group,
    p_entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_user,
        'amount', 30000,
        'direction', 'cash_in',
        'category', 'agent_bonus',
        'ledger_scope', 'wallet',
        'wallet_bucket', 'withdrawable',
        'recipient_type', 'user',
        'classification', 'production',
        'description', 'Watsala Enock — visible re-credit of net UGX 30,000 refund (KANUNA KEITH rejection reset post-anchor)'
      ),
      jsonb_build_object(
        'user_id', '00000000-0000-0000-0000-000000000000',
        'amount', 30000,
        'direction', 'cash_out',
        'category', 'platform_expense',
        'ledger_scope', 'platform',
        'classification', 'production',
        'description', 'Platform expense — Watsala Enock rejection-refund reset'
      )
    ),
    p_idempotency_key := 'watsala-enock-refund-reset-2026-07-22',
    p_skip_balance_check := true
  );

  INSERT INTO audit_logs (action_type, table_name, record_id, metadata)
  VALUES (
    'wallet_operator_reset', 'wallets', v_user::text,
    jsonb_build_object(
      'reason', 'Reset anchor+30000 visibility fix',
      'pre_anchor_withdrawable_raw', v_raw,
      'credited', 30000,
      'group_id', v_group
    )
  );
END $$;
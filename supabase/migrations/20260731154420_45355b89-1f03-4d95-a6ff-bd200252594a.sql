DO $$
DECLARE
  v_req withdrawal_requests%ROWTYPE;
  v_group uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_req FROM withdrawal_requests WHERE id = '1c895e93-91f3-4c78-b828-e40d28234d0e' FOR UPDATE;
  IF v_req.status <> 'pending' THEN
    RAISE NOTICE 'already settled: %', v_req.status;
    RETURN;
  END IF;

  -- Release the self-hold first so the strict balance check sees the real
  -- withdrawable balance backing this already-paid payout.
  UPDATE withdrawal_requests
     SET status = 'completed',
         processed_at = now(),
         transaction_id = COALESCE(NULLIF(transaction_id, ''), 'MANUAL-SETTLED'),
         transaction_time = now(),
         updated_at = now()
   WHERE id = v_req.id;

  PERFORM public.create_ledger_transaction(
    v_group,
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_req.user_id,
        'amount', v_req.amount,
        'direction', 'cash_out',
        'category', 'wallet_withdrawal',
        'ledger_scope', 'wallet',
        'recipient_type', 'user',
        'wallet_bucket', 'withdrawable',
        'classification', 'production',
        'source_table', 'withdrawal_requests',
        'reference_id', v_req.id::text,
        'description', 'Wallet withdrawal – Mobile Money already paid outside app (manual settlement)'
      ),
      jsonb_build_object(
        'amount', v_req.amount,
        'direction', 'cash_in',
        'category', 'wallet_withdrawal',
        'ledger_scope', 'platform',
        'classification', 'production',
        'source_table', 'withdrawal_requests',
        'reference_id', v_req.id::text,
        'description', 'Platform records withdrawal payout – manual settlement (already processed)'
      )
    ),
    'manual-settle-withdrawal-' || v_req.id::text,
    false
  );
END $$;
DO $$
DECLARE
  r record;
  v_entries jsonb;
BEGIN
  FOR r IN
    SELECT dr.id, dr.user_id, dr.amount, dr.transaction_id
    FROM public.deposit_requests dr
    WHERE dr.created_at >= '2026-08-14 13:55:00+00'
      AND dr.created_at <= '2026-08-14 13:56:30+00'
      AND dr.status = 'rejected'
  LOOP
    v_entries := jsonb_build_array(
      jsonb_build_object(
        'amount', r.amount,
        'direction', 'cash_out',
        'category', 'system_balance_correction',
        'ledger_scope', 'wallet',
        'user_id', r.user_id,
        'wallet_bucket', 'float',
        'recipient_type', 'operational_wallet',
        'currency', 'UGX',
        'source_table', 'deposit_requests',
        'source_id', r.id,
        'reference_id', r.transaction_id,
        'classification', 'admin_correction',
        'solvency_bypass_reason', 'duplicate_reversal',
        'description', 'Balance effect: historical merchant float sweep credit settled back (2026-08-14)'
      ),
      jsonb_build_object(
        'amount', r.amount,
        'direction', 'cash_in',
        'category', 'system_balance_correction',
        'ledger_scope', 'platform',
        'currency', 'UGX',
        'source_table', 'deposit_requests',
        'source_id', r.id,
        'reference_id', r.transaction_id,
        'classification', 'admin_correction',
        'description', 'Platform side: historical merchant float sweep credit settled back'
      )
    );

    PERFORM public.create_ledger_transaction(
      v_entries,
      'sweep-reversal-balance-' || r.id::text,
      true
    );
  END LOOP;
END $$;
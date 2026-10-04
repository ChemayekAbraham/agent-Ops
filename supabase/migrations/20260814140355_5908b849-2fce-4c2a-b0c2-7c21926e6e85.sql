DO $$
DECLARE
  r record;
  v_entries jsonb;
  v_group uuid;
BEGIN
  FOR r IN
    SELECT dr.id, dr.user_id, dr.amount, dr.provider, dr.transaction_id
    FROM public.deposit_requests dr
    WHERE dr.created_at >= '2026-08-14 13:55:00+00'
      AND dr.created_at <= '2026-08-14 13:56:30+00'
      AND dr.status = 'approved'
  LOOP
    v_entries := jsonb_build_array(
      jsonb_build_object(
        'amount', r.amount,
        'direction', 'cash_out',
        'category', 'agent_float_deposit',
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
        'description', 'Reversal: automatic historical merchant float sweep reversed (2026-08-14)'
      ),
      jsonb_build_object(
        'amount', r.amount,
        'direction', 'cash_in',
        'category', 'agent_float_deposit',
        'ledger_scope', 'platform',
        'currency', 'UGX',
        'source_table', 'deposit_requests',
        'source_id', r.id,
        'reference_id', r.transaction_id,
        'classification', 'admin_correction',
        'description', 'Reversal: platform side of reversed historical merchant float sweep'
      )
    );

    v_group := public.create_ledger_transaction(
      v_entries,
      'sweep-reversal-' || r.id::text,
      true
    );

    UPDATE public.deposit_requests
    SET status = 'rejected',
        rejected_at = now(),
        rejection_reason = 'Reversed: created by the automatic historical merchant float sweep on 2026-08-14 and settled back; not an approved credit.',
        updated_at = now()
    WHERE id = r.id;

    UPDATE public.gmail_transactions
    SET linked_deposit_request_id = NULL
    WHERE linked_deposit_request_id = r.id;

    INSERT INTO public.audit_logs (action_type, action, table_name, record_id, metadata)
    VALUES (
      'sweep_credit_reversed',
      'Historical merchant float sweep credit settled back per instruction; sweep scope limited to live gaps only.',
      'deposit_requests',
      r.id,
      jsonb_build_object('amount', r.amount, 'transaction_id', r.transaction_id, 'reversal_group', v_group)
    );
  END LOOP;
END $$;
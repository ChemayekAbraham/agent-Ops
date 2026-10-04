DO $$
DECLARE
  v_tenant uuid := '6aac6c81-b0f8-45eb-a67b-6483e7dcf82f';
  v_rr uuid := '260d0c85-27de-49ba-9e6d-d0f0c980e674';
  v_group uuid;
  v_prev_repaid numeric;
BEGIN
  SELECT amount_repaid INTO v_prev_repaid FROM public.rent_requests WHERE id = v_rr;

  -- 1. Balanced reversal of the erroneous auto deduction
  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_tenant,
        'category', 'tenant_repayment',
        'amount', 13000,
        'direction', 'cash_in',
        'ledger_scope', 'wallet',
        'recipient_type', 'user',
        'wallet_bucket', 'withdrawable',
        'classification', 'production',
        'description', 'System error reversal: auto rent deduction of UGX 13,000 (Ref PAY-MSCX38M6-5BFR) taken while repayment pause 4265c75c was active. Funds restored to wallet.',
        'reference_id', 'REV-PAY-MSCX38M6-5BFR',
        'source_table', 'rent_requests',
        'source_id', v_rr
      ),
      jsonb_build_object(
        'category', 'tenant_repayment',
        'amount', 13000,
        'direction', 'cash_out',
        'ledger_scope', 'platform',
        'classification', 'production',
        'description', 'System error reversal: platform returns rent repayment of UGX 13,000 (Ref PAY-MSCX38M6-5BFR)',
        'reference_id', 'REV-PAY-MSCX38M6-5BFR',
        'source_table', 'rent_requests',
        'source_id', v_rr
      )
    ),
    'reversal:PAY-MSCX38M6-5BFR:tenant_repayment:13000',
    true
  );

  -- 2. Undo the repayment record and the recorded repaid amount
  DELETE FROM public.repayments WHERE id = '5330a426-4da3-4db1-9783-9bc59d1a3c69';

  UPDATE public.rent_requests
     SET amount_repaid = GREATEST(0, COALESCE(amount_repaid, 0) - 13000),
         updated_at = now()
   WHERE id = v_rr;

  -- 3. Audit trail
  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (
    v_tenant,
    'system_error_reversal',
    'Reversed erroneous auto rent deduction of UGX 13,000 taken during an active repayment pause and restored the funds to the tenant wallet.',
    'general_ledger',
    '5a80357a-b88c-4f94-b6c6-764f152ce25b',
    jsonb_build_object(
      'reason', 'Automatic rent deduction executed on 2026-08-03 while repayment pause 4265c75c-cdbb-47d4-a321-ded6f4aae48a (until 2026-08-29) was active. Classified as a system error.',
      'amount', 13000,
      'currency', 'UGX',
      'original_reference', 'PAY-MSCX38M6-5BFR',
      'reversed_ledger_entries', jsonb_build_array('5a80357a-b88c-4f94-b6c6-764f152ce25b','ed79dc97-a1e2-4b6d-8d80-c86cfe7e38c6'),
      'reversal_transaction_group_id', v_group,
      'deleted_repayment_id', '5330a426-4da3-4db1-9783-9bc59d1a3c69',
      'rent_request_id', v_rr,
      'amount_repaid_before', v_prev_repaid,
      'amount_repaid_after', GREATEST(0, COALESCE(v_prev_repaid,0) - 13000)
    )
  );
END $$;
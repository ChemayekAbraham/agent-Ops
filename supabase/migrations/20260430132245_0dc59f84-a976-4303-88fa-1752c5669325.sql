DO $$
DECLARE
  v_user_id uuid := '99890a2e-b842-4d44-8516-e2eafe0711ff';
  v_amount  numeric := 300000;
  v_txn_id  uuid;
  v_actor   uuid;
  v_ref     text;
  v_existing int;
BEGIN
  -- Idempotency guard: if a goodwill credit was already posted for this withdrawal, skip.
  SELECT count(*) INTO v_existing
  FROM public.audit_logs
  WHERE action_type = 'cfo_goodwill_wallet_credit'
    AND record_id = '76250ae6-3657-4058-a882-6db9894b8a43';
  IF v_existing > 0 THEN
    RAISE NOTICE 'Goodwill credit already posted; skipping.';
    RETURN;
  END IF;

  SELECT ur.user_id INTO v_actor
  FROM public.user_roles ur
  WHERE ur.role IN ('cfo','manager')
  ORDER BY CASE ur.role WHEN 'cfo' THEN 0 WHEN 'manager' THEN 1 END
  LIMIT 1;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'No manager/cfo actor found for goodwill credit';
  END IF;

  v_ref := 'PAY-GOODWILL-GRACE-' || to_char(now(), 'YYYYMMDDHH24MISS');

  v_txn_id := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id',          v_user_id,
        'amount',           v_amount,
        'direction',        'cash_in',
        'category',         'system_balance_correction',
        'ledger_scope',     'wallet',
        'source_table',     'cfo_direct_credit',
        'reference_id',     v_ref,
        'description',      'Welile Technologies Finance [💰 Goodwill]: restore funding for pending withdrawal (Apr 30 advance recovery offset)',
        'currency',         'UGX',
        'recipient_type',   'user',
        'transaction_date', now()
      ),
      jsonb_build_object(
        'user_id',          v_actor,
        'amount',           v_amount,
        'direction',        'cash_out',
        'category',         'payroll_expense',
        'ledger_scope',     'platform',
        'source_table',     'cfo_direct_credit',
        'reference_id',     v_ref,
        'description',      'Welile Technologies Finance → Grace Paul Ochieng [goodwill]: paid pending UGX 300,000 withdrawal while keeping advance recovery applied',
        'currency',         'UGX',
        'transaction_date', now()
      )
    ),
    skip_balance_check := true
  );

  INSERT INTO public.audit_logs (
    action_type, table_name, record_id, user_id, action, metadata
  ) VALUES (
    'cfo_goodwill_wallet_credit',
    'withdrawal_requests',
    '76250ae6-3657-4058-a882-6db9894b8a43',
    v_actor,
    'CFO_OVERRIDE_GOODWILL_CREDIT',
    jsonb_build_object(
      'reason',                'CFO override: pay pending UGX 300,000 withdrawal AND keep Apr 30 advance auto-recovery applied for Grace Paul Ochieng.',
      'beneficiary_user_id',   v_user_id,
      'amount_ugx',            v_amount,
      'withdrawal_request_id', '76250ae6-3657-4058-a882-6db9894b8a43',
      'ledger_transaction_id', v_txn_id,
      'reference_id',          v_ref,
      'context','Apr 30 04:00 cron applied 300k payroll to advance; CFO chose to forgive 300k so withdrawal can still be paid.'
    )
  );

  RAISE NOTICE 'Goodwill credit posted: txn=% ref=%', v_txn_id, v_ref;
END $$;
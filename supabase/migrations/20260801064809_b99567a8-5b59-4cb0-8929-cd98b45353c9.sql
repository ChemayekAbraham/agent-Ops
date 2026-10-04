DO $$
DECLARE
  v_agent uuid := '506fe801-a72c-43ec-96c9-2b00a99d9258';
  v_adv   uuid := 'bbb820d7-2ae8-4b1e-80ca-68a48a76e2db';
  v_amt   numeric := 500;
  v_group uuid;
  v_open  numeric;
BEGIN
  SELECT outstanding_balance INTO v_open FROM public.agent_advances WHERE id = v_adv;
  IF v_open IS NULL THEN RAISE NOTICE 'advance missing, skipping'; RETURN; END IF;

  IF EXISTS (SELECT 1 FROM public.general_ledger
             WHERE idempotency_key = 'advance-freq-reversal-' || v_adv::text) THEN
    RAISE NOTICE 'already reversed';
    RETURN;
  END IF;

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_agent::text,
        'ledger_scope', 'wallet',
        'direction', 'cash_in',
        'category', 'agent_repayment',
        'amount', v_amt,
        'recipient_type', 'user',
        'wallet_bucket', 'withdrawable',
        'classification', 'production',
        'source_table', 'agent_advances',
        'source_id', v_adv::text,
        'description', 'Reversal of premature advance deduction (monthly schedule not yet due)'
      ),
      jsonb_build_object(
        'ledger_scope', 'platform',
        'direction', 'cash_out',
        'category', 'agent_repayment',
        'amount', v_amt,
        'recipient_type', 'operational_wallet',
        'classification', 'production',
        'source_table', 'agent_advances',
        'source_id', v_adv::text,
        'description', 'Refund of premature advance recovery to agent wallet'
      )
    ),
    'advance-freq-reversal-' || v_adv::text
  );

  UPDATE public.agent_advances
  SET outstanding_balance = outstanding_balance + v_amt,
      updated_at = now()
  WHERE id = v_adv;

  INSERT INTO public.agent_advance_ledger (
    advance_id, date, opening_balance, interest_accrued,
    amount_deducted, closing_balance, deduction_status
  ) VALUES (
    v_adv, CURRENT_DATE, v_open, 0, 0, v_open + v_amt, 'not_due'
  );

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  VALUES (
    v_agent,
    'advance_frequency_reversal',
    'agent_advances',
    v_adv,
    'Reversed premature daily deduction on a monthly-frequency advance',
    jsonb_build_object(
      'reason', 'Repayment frequency fix: monthly advances must only be collected on their due day. UGX 500 collected on 2026-07-29 was premature and has been refunded.',
      'amount_reversed', v_amt,
      'transaction_group_id', v_group,
      'incident', 'agent-advance-frequency-remediation'
    )
  );

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'wallet_historical_drift_absorbed',
    v_agent,
    'agent_advance',
    v_adv,
    jsonb_build_object(
      'source', 'advance_frequency_remediation',
      'amount_refunded', v_amt,
      'transaction_group_id', v_group
    )
  );
END $$;
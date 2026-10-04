
DO $$
DECLARE
  v_isaac uuid := '9788c998-4484-4d84-80e4-8cd7933cf046';
  v_pamela uuid := '9a20da54-829f-435d-b717-ca59a5e22658';
  v_joshua uuid := '83f86f1c-ce49-472a-8dd4-4023ce060e10';
  v_isaac_pf uuid;
  v_pamela_pf uuid;
  v_joshua_pf uuid;
BEGIN
  SELECT id INTO v_isaac_pf FROM public.investor_portfolios WHERE portfolio_code='WIP2607247541';
  SELECT id INTO v_pamela_pf FROM public.investor_portfolios WHERE portfolio_code='WIP2607247717';
  SELECT id INTO v_joshua_pf FROM public.investor_portfolios WHERE portfolio_code='WIP2607231285';

  -- ISAAC — 200,000
  IF v_isaac_pf IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.general_ledger
     WHERE reference_id='WIP2607247541' AND category='partner_funding' AND direction='cash_out'
  ) THEN
    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_isaac::text,
          'amount', 200000,
          'direction','cash_out',
          'category','partner_funding',
          'ledger_scope','wallet',
          'recipient_type','user',
          'description','Backfill: partner wallet debit for portfolio WIP2607247541 (ISAAC KAMUGISHA) — UGX 200,000. Wallet was credited but not debited at creation.',
          'source_table','investor_portfolios',
          'source_id', v_isaac_pf::text,
          'reference_id','WIP2607247541',
          'linked_party','platform'
        ),
        jsonb_build_object(
          'amount', 200000,
          'direction','cash_in',
          'category','partner_funding',
          'ledger_scope','platform',
          'description','Backfill: platform capital received for portfolio WIP2607247541 (ISAAC KAMUGISHA)',
          'source_table','investor_portfolios',
          'source_id', v_isaac_pf::text,
          'reference_id','WIP2607247541',
          'linked_party', v_isaac::text
        )
      ),
      idempotency_key := 'backfill-portfolio-debit-WIP2607247541'
    );
  END IF;

  -- PAMELA — 50,000,000 + flip her pending portfolio to active/verified
  IF v_pamela_pf IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.general_ledger
     WHERE reference_id='WIP2607247717' AND category='partner_funding' AND direction='cash_out'
  ) THEN
    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_pamela::text,
          'amount', 50000000,
          'direction','cash_out',
          'category','partner_funding',
          'ledger_scope','wallet',
          'recipient_type','user',
          'description','Backfill: partner wallet debit for portfolio WIP2607247717 (PAMELA SSAKA) — UGX 50,000,000. Wallet was credited but not debited at creation.',
          'source_table','investor_portfolios',
          'source_id', v_pamela_pf::text,
          'reference_id','WIP2607247717',
          'linked_party','platform'
        ),
        jsonb_build_object(
          'amount', 50000000,
          'direction','cash_in',
          'category','partner_funding',
          'ledger_scope','platform',
          'description','Backfill: platform capital received for portfolio WIP2607247717 (PAMELA SSAKA)',
          'source_table','investor_portfolios',
          'source_id', v_pamela_pf::text,
          'reference_id','WIP2607247717',
          'linked_party', v_pamela::text
        )
      ),
      idempotency_key := 'backfill-portfolio-debit-WIP2607247717'
    );

    UPDATE public.investor_portfolios
       SET status = 'active',
           cfo_verified = true,
           cfo_verified_at = now(),
           cfo_rejection_reason = NULL,
           maturity_date = COALESCE(maturity_date, (created_at + (duration_months || ' months')::interval)::date)
     WHERE id = v_pamela_pf
       AND status = 'awaiting_partner_details';
  END IF;

  -- MBAKUREEBA JOSHUA — 4,900,000
  IF v_joshua_pf IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.general_ledger
     WHERE reference_id='WIP2607231285' AND category='partner_funding' AND direction='cash_out'
  ) THEN
    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_joshua::text,
          'amount', 4900000,
          'direction','cash_out',
          'category','partner_funding',
          'ledger_scope','wallet',
          'recipient_type','user',
          'description','Backfill: partner wallet debit for portfolio WIP2607231285 (Mbakureeba Joshua) — UGX 4,900,000. Wallet was credited but not debited at creation.',
          'source_table','investor_portfolios',
          'source_id', v_joshua_pf::text,
          'reference_id','WIP2607231285',
          'linked_party','platform'
        ),
        jsonb_build_object(
          'amount', 4900000,
          'direction','cash_in',
          'category','partner_funding',
          'ledger_scope','platform',
          'description','Backfill: platform capital received for portfolio WIP2607231285 (Mbakureeba Joshua)',
          'source_table','investor_portfolios',
          'source_id', v_joshua_pf::text,
          'reference_id','WIP2607231285',
          'linked_party', v_joshua::text
        )
      ),
      idempotency_key := 'backfill-portfolio-debit-WIP2607231285'
    );
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    NULL,
    'portfolio_debit_backfill',
    'investor_portfolios',
    NULL,
    jsonb_build_object(
      'partners', jsonb_build_array('ISAAC KAMUGISHA','PAMELA SSAKA','Mbakureeba Joshua'),
      'portfolios', jsonb_build_array('WIP2607247541','WIP2607247717','WIP2607231285'),
      'reason', 'Wallets were credited but never debited on portfolio creation (invite-mode fallthrough). Wallets dehydrated to match principal.'
    )
  );
END $$;

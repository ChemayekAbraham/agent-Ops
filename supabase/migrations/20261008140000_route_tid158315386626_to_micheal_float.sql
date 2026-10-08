-- One-off: route Airtel TID158315386626 (UGX 10,000 from 0730647169, 2026-10-08 05:57 UTC)
-- to agent Okwakol Micheal's FLOAT, as TID-backed float.
--
-- Why SQL: the Email Transactions Route dialog is blocked for this email. It treated the
-- email's amount-only link to Pauline Asianut's PENDING request 100d839e-... as a prior
-- auto-credit and sent a debit against her first, which non-CFO-approvers are refused
-- ("Reversal failed: This request could not be completed"). Dialog fixed in doc 210 but not
-- deployed. Josh (2026-10-08): do it by SQL.
--
-- Shape mirrors Micheal's working 5 Oct routed credit (PAY-MUVD7K6P-ECJ6, TID158115832102):
-- agent_float_deposit / source_table cfo_direct_credit / sub_category = the TID, a wallet leg
-- plus a platform offset, plus the email_credit_idempotency row cfo-direct-credit writes so
-- the dialog cannot credit the same email twice. tg_credit_tid_backed_float then counts it
-- (doc 113); the block rolls back if his TID-backed balance does not rise by exactly 10,000.
--
-- Pauline's request is NOT touched.
DO $$
DECLARE
  c_micheal  constant uuid    := '75891dff-d684-49e9-83ea-fab6e4cb4ded';
  c_operator constant uuid    := '59d45ad2-0d44-433c-b4ec-20927a25c281'; -- Nankambo, platform-leg actor as on 5 Oct
  c_gmail    constant uuid    := 'da604405-265b-4cb6-bdd9-a87b445cbbc3';
  c_tid      constant text    := 'TID158315386626';
  c_amt      constant numeric := 10000;
  c_ref      constant text    := 'PAY-' || 'TID158315386626';
  c_ts       constant timestamptz := '2026-10-08 05:57:00+00';
  v_msg    text;
  v_before numeric;
  v_after  numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM public.email_credit_idempotency WHERE email_tid = c_tid)
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE sub_category = c_tid AND ledger_scope = 'wallet') THEN
    RETURN; -- already credited
  END IF;

  SELECT gmail_message_id INTO v_msg FROM public.gmail_transactions
   WHERE id = c_gmail AND transaction_id = c_tid AND direction = 'in' AND amount = c_amt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Email % not found as an inbound % of %; live state differs', c_gmail, c_tid, c_amt;
  END IF;

  SELECT COALESCE((SELECT balance FROM public.agent_tid_backed_float WHERE agent_id = c_micheal), 0) INTO v_before;

  INSERT INTO public.email_credit_idempotency
    (gmail_transaction_id, gmail_message_id, email_tid, target_user_id, amount, operation, reference_id)
  VALUES (c_gmail, v_msg, c_tid, c_micheal, c_amt, 'credit', c_ref);

  PERFORM public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', c_micheal, 'amount', c_amt, 'direction', 'cash_in',
        'category', 'agent_float_deposit', 'ledger_scope', 'wallet',
        'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
        'routing_source', 'cfo_direct_credit_locked_agent_float_deposit',
        'source_table', 'cfo_direct_credit', 'sub_category', c_tid,
        'reference_id', c_ref, 'classification', 'production', 'transaction_date', c_ts,
        'description', 'Welile Technologies Finance [Operational Float (from email)] → ' || c_tid || ': Routed inbound deposit email (Airtel UGX 10,000 from 0730647169, 08-Oct-2026 05:57 UTC) by SQL after the Route dialog failed'),
      jsonb_build_object(
        'user_id', c_operator, 'amount', c_amt, 'direction', 'cash_out',
        'category', 'agent_float_deposit', 'ledger_scope', 'platform',
        'source_table', 'cfo_direct_credit', 'sub_category', c_tid,
        'reference_id', c_ref, 'classification', 'production', 'transaction_date', c_ts,
        'description', 'Welile Technologies Finance → Okwakol Micheal [neutral]: Routed inbound deposit email ' || c_tid || ' (SQL).')
    ),
    idempotency_key := 'tid_float_route:' || c_tid,
    skip_balance_check := true
  );

  SELECT COALESCE((SELECT balance FROM public.agent_tid_backed_float WHERE agent_id = c_micheal), 0) INTO v_after;
  IF v_after - v_before <> c_amt THEN
    RAISE EXCEPTION 'TID-backed float moved by % instead of %; rolling back', v_after - v_before, c_amt;
  END IF;

  PERFORM public.reconcile_wallet_from_ledger(c_micheal);
END $$;

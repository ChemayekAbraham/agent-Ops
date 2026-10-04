DO $$
DECLARE
  v_pid uuid := '7213701b-a356-4378-bc8d-f090dad8b550';
  v_pending public.funder_pending_portfolios%ROWTYPE;
  v_ref text;
  v_group uuid;
BEGIN
  SELECT * INTO v_pending FROM public.funder_pending_portfolios
   WHERE portfolio_id = v_pid AND status = 'pending' FOR UPDATE;

  UPDATE public.investor_portfolios
     SET status = 'active',
         next_roi_date = COALESCE(next_roi_date, (now() + interval '30 days')::date),
         maturity_date = COALESCE(maturity_date, (now() + interval '12 months')::date)
   WHERE id = v_pid;

  IF v_pending.id IS NOT NULL THEN
    -- Release the pending reservation first so the funding debit is not blocked
    -- by its own hold (funder_pending_hold only counts status = 'pending').
    UPDATE public.funder_pending_portfolios
       SET status = 'approved', reviewed_at = now(), updated_at = now()
     WHERE id = v_pending.id;

    v_ref := 'WRF' || to_char(now(), 'YYMMDD') || lpad((floor(random()*9000)+1000)::int::text, 4, '0');
    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_pending.funder_id, 'amount', v_pending.amount, 'direction', 'cash_out',
          'category', 'partner_funding', 'ledger_scope', 'wallet',
          'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
          'source_table', 'investor_portfolios', 'source_id', v_pid,
          'reference_id', v_ref,
          'linked_party', 'Rent Management Pool',
          'description', 'Partner rent pool funding approved by Partner Ops'
        ),
        jsonb_build_object(
          'amount', v_pending.amount, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'source_table', 'investor_portfolios', 'source_id', v_pid,
          'reference_id', v_ref,
          'linked_party', v_pending.funder_id::text,
          'description', 'Partner capital received into Rent Management Pool'
        )
      ),
      idempotency_key := 'funder-pending-' || v_pending.id::text
    );
  END IF;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, metadata)
  VALUES ('approve_pending_portfolio', 'investor_portfolios', v_pid,
    'Manual activation of portfolio WPF-5835 on operator instruction',
    jsonb_build_object('portfolio_code','WPF-5835','ledger_group_id', v_group, 'prev_status','pending_ops_approval'));
END $$;
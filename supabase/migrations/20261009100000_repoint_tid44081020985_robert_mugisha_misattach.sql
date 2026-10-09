-- One-off: MTN TID 44081020985 (UGX 20,000 from ROBERT MUGISHA, 2026-10-08 18:22 EAT, Till 090777)
-- was auto-credited to the WRONG Robert Mugisha. Move it to the tenant who paid and settle it to
-- his Rent Plan.
--
-- What happened: gmail-poll-transactions matched the receipt by NAME only (the MTN "received"
-- SMS carries no sender phone: match_method 'name', phone_source NULL). Two profiles share the
-- name, and the tie-break picked the more recently active one:
--   wrong : dc676bca-c64b-450c-96d3-2928cf821bc2  (+256779166640)  -> got 20,000 as float
--   right : 86eb32d3-43a5-462b-b698-186b83cec8d0  (+256794402225)  -> Rent Plan ef5e2e18-..., repaying
-- The wrong profile's wallet holds exactly this 20,000 and nothing else (checked 2026-10-09), so a
-- full reversal is clean. The tenant's first 20,000 (TID 44056802806, 7 Oct) took the same
-- path correctly: float credit on an approved deposit -> trg_tenant_self_repayment_on_approval ->
-- settle_tenant_rent_from_deposit (tenant_deposit_auto collection, agent commission, SMS).
--
-- Shape: keep the ONE deposit_request (4fa90cec-...) so the TID, the Gmail link and the audit
-- trail stay on a single row, and the TID stays single-use.
--   1. reverse the wrong profile's ledger group (opposite legs, same category, as the 44
--      historical float reversals did), then reconcile its wallet;
--   2. release the TID claim the reversed credit left behind (enforce_tid_deposit_uniqueness
--      refuses a second cash_in leg while a claim exists; the new leg re-records it);
--   3. park the deposit as pending while its owner changes (enforce_auto_deposit_requires_ledger
--      and the settle trigger both key off status), re-point it to the tenant;
--   4. post the tenant's float credit with the same shape as the original;
--   5. approve -> the existing trigger settles the plan and queues tenant + agent SMS.
-- The block rolls back unless the plan settled the full 20,000 and both wallets end where expected.
-- Idempotent: returns once the deposit already belongs to the tenant.
DO $$
DECLARE
  c_dep     constant uuid    := '4fa90cec-0f50-41ce-a837-1065ba391873';
  c_gmail   constant uuid    := '0de1c136-75f0-43ca-8cb5-9da4a85ea89e';
  c_wrong   constant uuid    := 'dc676bca-c64b-450c-96d3-2928cf821bc2';
  c_tenant  constant uuid    := '86eb32d3-43a5-462b-b698-186b83cec8d0';
  c_rr      constant uuid    := 'ef5e2e18-e325-4d4a-b7c2-31d3cd974f54';
  c_tid     constant text    := '44081020985';
  c_amt     constant numeric := 20000;
  c_orig_grp constant uuid   := '3b656802-d097-4881-8192-21bd5f0572a9';
  c_ts      constant timestamptz := '2026-10-08 17:53:08.271+00';
  v_owner   uuid;
  v_status  text;
  v_wrong_float  numeric;
  v_tenant_float numeric;
  v_repaid_before numeric;
  v_repaid_after  numeric;
  v_outcome text;
  v_applied numeric;
BEGIN
  SELECT user_id, status::text INTO v_owner, v_status
    FROM public.deposit_requests
   WHERE id = c_dep AND transaction_id = c_tid AND amount = c_amt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deposit % (TID %, %) not found; live state differs', c_dep, c_tid, c_amt;
  END IF;
  IF v_owner = c_tenant THEN
    RETURN; -- already re-pointed
  END IF;
  IF v_owner <> c_wrong OR v_status <> 'approved' THEN
    RAISE EXCEPTION 'Deposit % is owned by % with status %; expected the wrong profile, approved', c_dep, v_owner, v_status;
  END IF;

  PERFORM 1 FROM public.gmail_transactions
   WHERE id = c_gmail AND transaction_id = c_tid AND direction = 'in' AND amount = c_amt
     AND linked_deposit_request_id = c_dep;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Gmail receipt % is not the inbound % of % linked to deposit %', c_gmail, c_tid, c_amt, c_dep;
  END IF;

  IF (SELECT COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END), 0)
        FROM public.general_ledger
       WHERE transaction_group_id = c_orig_grp AND ledger_scope = 'wallet' AND user_id = c_wrong
         AND wallet_bucket = 'float') <> c_amt THEN
    RAISE EXCEPTION 'Original ledger group % is not a single % float credit to the wrong profile', c_orig_grp, c_amt;
  END IF;

  -- The wrong profile must still hold the whole amount; a spent credit needs a human decision.
  PERFORM public.reconcile_wallet_from_ledger(c_wrong);
  SELECT COALESCE(float_balance, 0) INTO v_wrong_float FROM public.wallets WHERE user_id = c_wrong;
  IF v_wrong_float < c_amt THEN
    RAISE EXCEPTION 'Wrong profile float is % (< %): the credit was partly spent; refusing to reverse', v_wrong_float, c_amt;
  END IF;

  SELECT COALESCE(amount_repaid, 0) INTO v_repaid_before FROM public.rent_requests WHERE id = c_rr;

  -- 1. Reverse the wrong profile's credit.
  PERFORM public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', c_wrong, 'amount', c_amt, 'direction', 'cash_out',
        'category', 'agent_float_deposit', 'ledger_scope', 'wallet',
        'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
        'classification', 'production',
        'source_table', 'deposit_requests', 'source_id', c_dep,
        'reference_id', 'REV-' || c_tid, 'transaction_date', now(),
        'description', 'Reversal: MTN TID ' || c_tid || ' UGX 20,000 was auto-credited by name to the wrong Robert Mugisha; re-pointed to the payer (doc 212)'),
      jsonb_build_object(
        'amount', c_amt, 'direction', 'cash_in',
        'category', 'agent_float_deposit', 'ledger_scope', 'platform',
        'classification', 'production',
        'source_table', 'deposit_requests', 'source_id', c_dep,
        'reference_id', 'REV-' || c_tid, 'transaction_date', now(),
        'description', 'Platform offset: reversal of misattached float deposit TID ' || c_tid || ' (doc 212)')
    ),
    idempotency_key := 'rev_misattached_deposit:' || c_tid,
    skip_balance_check := true
  );
  PERFORM public.reconcile_wallet_from_ledger(c_wrong);

  -- 2. Release the TID claim left by the reversed credit; the tenant's leg re-records it.
  DELETE FROM public.ledger_reconciled_tids
   WHERE tid_normalized = c_tid AND source = 'general_ledger';

  -- 3. Park, then re-point. Pending keeps the approval-side triggers quiet while the owner changes.
  UPDATE public.deposit_requests
     SET status = 'pending',
         user_id = c_tenant,
         agent_id = NULL,
         auto_credit_review_status = NULL,
         notes = COALESCE(notes, '') || E'\n[doc 212 2026-10-09] Re-pointed from dc676bca (wrong same-name profile) to the payer 86eb32d3 (+256794402225, sender of this MTN receipt). Original credit reversed.'
   WHERE id = c_dep;

  -- 4. The tenant's float credit, same shape as the original auto-credit.
  PERFORM public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', c_tenant, 'amount', c_amt, 'direction', 'cash_in',
        'category', 'agent_float_deposit', 'ledger_scope', 'wallet',
        'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
        'classification', 'production',
        'source_table', 'deposit_requests', 'source_id', c_dep,
        'reference_id', c_tid, 'transaction_date', c_ts,
        'description', 'Operational float deposit via mtn (re-pointed to the payer, doc 212)'),
      jsonb_build_object(
        'amount', c_amt, 'direction', 'cash_out',
        'category', 'agent_float_deposit', 'ledger_scope', 'platform',
        'classification', 'production',
        'source_table', 'deposit_requests', 'source_id', c_dep,
        'reference_id', c_tid, 'transaction_date', c_ts,
        'description', 'Platform: float deposit credited to agent float bucket (re-pointed, doc 212)')
    ),
    idempotency_key := 'repoint_deposit_credit:' || c_tid,
    skip_balance_check := true
  );
  PERFORM public.reconcile_wallet_from_ledger(c_tenant);

  -- 5. Approve: trg_tenant_self_repayment_on_approval settles the Rent Plan and queues the SMS.
  UPDATE public.deposit_requests
     SET status = 'approved'
   WHERE id = c_dep;

  SELECT outcome, COALESCE(applied_amount, 0) INTO v_outcome, v_applied
    FROM public.tenant_self_repayment_attempts WHERE deposit_request_id = c_dep;
  IF v_outcome IS DISTINCT FROM 'settled' OR v_applied <> c_amt THEN
    RAISE EXCEPTION 'Rent Plan settlement did not complete (outcome %, applied %); rolling back', v_outcome, v_applied;
  END IF;

  SELECT COALESCE(amount_repaid, 0) INTO v_repaid_after FROM public.rent_requests WHERE id = c_rr;
  IF v_repaid_after - v_repaid_before <> c_amt THEN
    RAISE EXCEPTION 'Plan amount_repaid moved by % instead of %; rolling back', v_repaid_after - v_repaid_before, c_amt;
  END IF;

  PERFORM public.reconcile_wallet_from_ledger(c_tenant);
  SELECT COALESCE(float_balance, 0) INTO v_tenant_float FROM public.wallets WHERE user_id = c_tenant;
  SELECT COALESCE(float_balance, 0) INTO v_wrong_float  FROM public.wallets WHERE user_id = c_wrong;
  IF v_tenant_float <> 0 OR v_wrong_float <> 0 THEN
    RAISE EXCEPTION 'Float after fix: tenant %, wrong profile % (both should be 0); rolling back', v_tenant_float, v_wrong_float;
  END IF;
END $$;

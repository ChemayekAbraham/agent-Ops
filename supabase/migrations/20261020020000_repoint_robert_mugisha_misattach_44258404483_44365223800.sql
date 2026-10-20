-- One-off: MTN TIDs 44258404483 (UGX 20,000, 2026-10-15) and 44365223800 (UGX 40,000,
-- 2026-10-19) from ROBERT MUGISHA (0794402225) were auto-credited to the WRONG Robert Mugisha.
-- Same cause and same fix as 20261009100000_repoint_tid44081020985_robert_mugisha_misattach.sql.
--
--   wrong : dc676bca-c64b-450c-96d3-2928cf821bc2  (+256779166640)  -> got 60,000 as float, unspent
--   right : 86eb32d3-43a5-462b-b698-186b83cec8d0  (+256794402225)  -> Rent Plan ef5e2e18-..., repaying
--
-- For each deposit: reverse the wrong profile ledger group, release the TID claim, park the
-- deposit as pending, re-point it to the tenant, post the tenant float credit, then approve so
-- trg_tenant_self_repayment_on_approval settles the Rent Plan. The block rolls back unless the
-- plan settled the full 60,000 and both wallets end with float 0.
-- Idempotent: a deposit already owned by the tenant is skipped.
DO $$
DECLARE
  c_wrong   constant uuid := 'dc676bca-c64b-450c-96d3-2928cf821bc2';
  c_tenant  constant uuid := '86eb32d3-43a5-462b-b698-186b83cec8d0';
  c_rr      constant uuid := 'ef5e2e18-e325-4d4a-b7c2-31d3cd974f54';
  r record;
  v_owner uuid;
  v_status text;
  v_wrong_float numeric;
  v_tenant_float numeric;
  v_repaid_before numeric;
  v_repaid_after numeric;
  v_outcome text;
  v_applied numeric;
  v_total numeric := 0;
BEGIN
  SELECT COALESCE(amount_repaid, 0) INTO v_repaid_before FROM public.rent_requests WHERE id = c_rr;

  FOR r IN
    SELECT * FROM (VALUES
      ('2075fa16-6b8f-490f-8b63-aa526c59d892'::uuid, 'bee08d10-9bbc-4847-bb77-dfc3d23dec4d'::uuid, '44258404483', 20000::numeric, '73c1ec9a-4ffe-4f53-98de-63d1bba4956b'::uuid, '2026-10-15 17:20:04.242+00'::timestamptz),
      ('df3c5f49-6a48-413d-a820-7969f76b51bd'::uuid, 'fc30bc0d-3d09-4fd4-9977-1cfd388ae201'::uuid, '44365223800', 40000::numeric, '225ec4af-14ef-410b-8b47-01640da65d55'::uuid, '2026-10-19 16:34:03.073+00'::timestamptz)
    ) AS x(dep, gmail, tid, amt, orig_grp, ts)
  LOOP
    SELECT user_id, status::text INTO v_owner, v_status
      FROM public.deposit_requests
     WHERE id = r.dep AND transaction_id = r.tid AND amount = r.amt;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Deposit % (TID %, %) not found; live state differs', r.dep, r.tid, r.amt;
    END IF;
    IF v_owner = c_tenant THEN
      CONTINUE;
    END IF;
    IF v_owner <> c_wrong OR v_status <> 'approved' THEN
      RAISE EXCEPTION 'Deposit % is owned by % with status %; expected the wrong profile, approved', r.dep, v_owner, v_status;
    END IF;

    PERFORM 1 FROM public.gmail_transactions
     WHERE id = r.gmail AND transaction_id = r.tid AND direction = 'in' AND amount = r.amt
       AND linked_deposit_request_id = r.dep;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Gmail receipt % is not the inbound % of % linked to deposit %', r.gmail, r.tid, r.amt, r.dep;
    END IF;

    IF (SELECT COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END), 0)
          FROM public.general_ledger
         WHERE transaction_group_id = r.orig_grp AND ledger_scope = 'wallet' AND user_id = c_wrong
           AND wallet_bucket = 'float') <> r.amt THEN
      RAISE EXCEPTION 'Original ledger group % is not a single % float credit to the wrong profile', r.orig_grp, r.amt;
    END IF;

    PERFORM public.reconcile_wallet_from_ledger(c_wrong);
    SELECT COALESCE(float_balance, 0) INTO v_wrong_float FROM public.wallets WHERE user_id = c_wrong;
    IF v_wrong_float < r.amt THEN
      RAISE EXCEPTION 'Wrong profile float is % (< %): the credit was partly spent; refusing to reverse', v_wrong_float, r.amt;
    END IF;

    -- 1. Reverse the wrong profile credit.
    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', c_wrong, 'amount', r.amt, 'direction', 'cash_out',
          'category', 'agent_float_deposit', 'ledger_scope', 'wallet',
          'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
          'classification', 'production',
          'source_table', 'deposit_requests', 'source_id', r.dep,
          'reference_id', 'REV-' || r.tid, 'transaction_date', now(),
          'description', 'Reversal: MTN TID ' || r.tid || ' was auto-credited by name to the wrong Robert Mugisha; re-pointed to the payer'),
        jsonb_build_object(
          'amount', r.amt, 'direction', 'cash_in',
          'category', 'agent_float_deposit', 'ledger_scope', 'platform',
          'classification', 'production',
          'source_table', 'deposit_requests', 'source_id', r.dep,
          'reference_id', 'REV-' || r.tid, 'transaction_date', now(),
          'description', 'Platform offset: reversal of misattached float deposit TID ' || r.tid)
      ),
      idempotency_key := 'rev_misattached_deposit:' || r.tid,
      skip_balance_check := true
    );
    PERFORM public.reconcile_wallet_from_ledger(c_wrong);

    -- 2. Release the TID claim left by the reversed credit.
    DELETE FROM public.ledger_reconciled_tids
     WHERE tid_normalized = r.tid AND source = 'general_ledger';

    -- 3. Park, then re-point.
    UPDATE public.deposit_requests
       SET status = 'pending',
           user_id = c_tenant,
           agent_id = NULL,
           auto_credit_review_status = NULL,
           notes = COALESCE(notes, '') || E'\n[2026-10-20] Re-pointed from dc676bca (wrong same-name profile) to the payer 86eb32d3 (+256794402225). Original credit reversed.'
     WHERE id = r.dep;

    -- 4. Tenant float credit, same shape as the original.
    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', c_tenant, 'amount', r.amt, 'direction', 'cash_in',
          'category', 'agent_float_deposit', 'ledger_scope', 'wallet',
          'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
          'classification', 'production',
          'source_table', 'deposit_requests', 'source_id', r.dep,
          'reference_id', r.tid, 'transaction_date', r.ts,
          'description', 'Operational float deposit via mtn (re-pointed to the payer)'),
        jsonb_build_object(
          'amount', r.amt, 'direction', 'cash_out',
          'category', 'agent_float_deposit', 'ledger_scope', 'platform',
          'classification', 'production',
          'source_table', 'deposit_requests', 'source_id', r.dep,
          'reference_id', r.tid, 'transaction_date', r.ts,
          'description', 'Platform: float deposit credited to agent float bucket (re-pointed)')
      ),
      idempotency_key := 'repoint_deposit_credit:' || r.tid,
      skip_balance_check := true
    );
    PERFORM public.reconcile_wallet_from_ledger(c_tenant);

    -- 5. Approve: the existing trigger settles the Rent Plan and queues the SMS.
    UPDATE public.deposit_requests SET status = 'approved' WHERE id = r.dep;

    SELECT outcome, COALESCE(applied_amount, 0) INTO v_outcome, v_applied
      FROM public.tenant_self_repayment_attempts WHERE deposit_request_id = r.dep;
    IF v_outcome IS DISTINCT FROM 'settled' OR v_applied <> r.amt THEN
      RAISE EXCEPTION 'Rent Plan settlement for % did not complete (outcome %, applied %); rolling back', r.tid, v_outcome, v_applied;
    END IF;
    v_total := v_total + r.amt;
  END LOOP;

  SELECT COALESCE(amount_repaid, 0) INTO v_repaid_after FROM public.rent_requests WHERE id = c_rr;
  IF v_repaid_after - v_repaid_before <> v_total THEN
    RAISE EXCEPTION 'Plan amount_repaid moved by % instead of %; rolling back', v_repaid_after - v_repaid_before, v_total;
  END IF;

  PERFORM public.reconcile_wallet_from_ledger(c_tenant);
  PERFORM public.reconcile_wallet_from_ledger(c_wrong);
  SELECT COALESCE(float_balance, 0) INTO v_tenant_float FROM public.wallets WHERE user_id = c_tenant;
  SELECT COALESCE(float_balance, 0) INTO v_wrong_float  FROM public.wallets WHERE user_id = c_wrong;
  IF v_tenant_float <> 0 OR v_wrong_float <> 0 THEN
    RAISE EXCEPTION 'Float after fix: tenant %, wrong profile % (both should be 0); rolling back', v_tenant_float, v_wrong_float;
  END IF;
END $$;

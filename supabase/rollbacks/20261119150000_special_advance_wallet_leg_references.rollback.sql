-- ROLLBACK of 20261119150000_special_advance_wallet_leg_references: production's definitions of 12 Nov 2026, verbatim.
CREATE OR REPLACE FUNCTION public.special_advance_pay_from_wallet(p_id uuid, p_amount bigint, p_expected_outstanding bigint, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- The borrower repays their own Special Advance from their Welile wallet, in ONE transaction:
--   the wallet leg (DR L1) and the receivable leg (CR A24) post as one ledger group, the repayment is recorded and
--   allocated by the same rule as a Merchant Line repayment, and the advance settles when nothing is left.
-- Any error rolls everything back, so a failed payment never leaves the wallet debited.
DECLARE
  v_uid uuid := auth.uid();
  v_today date := public._special_advance_kampala_today();
  v_client_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_key text;
  a public.special_advances%ROWTYPE;
  e public.special_advance_repayments%ROWTYPE;
  v_outstanding bigint;
  v_available numeric;
  v_rep uuid := gen_random_uuid();
  v_ref text;
  v_group uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF length(v_client_key) NOT BETWEEN 16 AND 60 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  -- scoped to the payer, so one person's key can never replay or block another person's payment
  v_key := 'w:' || v_uid::text || ':' || v_client_key;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:repayment:' || v_key, 0));
  SELECT * INTO e FROM public.special_advance_repayments WHERE idempotency_key = v_key;
  IF e.id IS NOT NULL THEN
    IF e.advance_id = p_id AND e.method = 'wallet' AND e.recorded_by = v_uid AND e.amount = p_amount THEN
      RETURN public._special_advance_wallet_receipt(e.id) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;

  -- only the borrower's own advance; anything else reads as not found
  SELECT * INTO a FROM public.special_advances
   WHERE id = p_id AND borrower_kind = 'welile_user' AND borrower_user_id = v_uid
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF a.status <> 'disbursed' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_REPAYABLE' USING ERRCODE = '22023', DETAIL = a.status;
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["amount"]';
  END IF;

  v_outstanding := (public._special_advance_position(a.id) ->> 'outstanding')::bigint;
  -- the payer confirmed against this balance; if it moved (another payment, a correction) they must look again
  IF p_expected_outstanding IS DISTINCT FROM v_outstanding THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_STATE_CHANGED' USING ERRCODE = '22023',
      DETAIL = jsonb_build_object('outstanding', v_outstanding)::text;
  END IF;
  IF p_amount > v_outstanding THEN
    RAISE EXCEPTION 'OVERPAYMENT_REFUSED' USING ERRCODE = '22023',
      DETAIL = jsonb_build_object('outstanding', v_outstanding)::text;
  END IF;

  -- Serialise with every other movement on this wallet: each wallet posting rewrites the owner's projection row and
  -- holds it until commit. After this lock the balance below is the committed one, and no other posting can change
  -- it until this payment commits or rolls back.
  PERFORM 1 FROM public.wallet_balances_projection WHERE user_id = v_uid FOR UPDATE;
  v_available := public.get_user_available_balance__impl(v_uid);
  IF COALESCE(v_available, 0) < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_WALLET_BALANCE' USING ERRCODE = '22023',
      DETAIL = jsonb_build_object('available', COALESCE(v_available, 0))::text;
  END IF;

  v_ref := 'WALLET-' || upper(substr(replace(v_rep::text, '-', ''), 1, 12));
  v_group := public.create_ledger_transaction(jsonb_build_array(
    jsonb_build_object('ledger_scope', 'wallet', 'direction', 'cash_out', 'amount', p_amount,
                       'category', 'special_advance_wallet_repayment', 'user_id', v_uid, 'wallet_bucket', 'withdrawable',
                       'recipient_type', 'user', 'source_table', 'special_advance_repayments', 'source_id', v_rep,
                       'reference_id', a.reference, 'currency', 'UGX',
                       'description', format('Special Advance %s repayment from your wallet, ref %s', a.reference, v_ref)),
    jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', p_amount,
                       'category', 'special_advance_wallet_repayment', 'source_table', 'special_advance_repayments', 'source_id', v_rep,
                       'reference_id', a.reference, 'currency', 'UGX',
                       'description', format('Special Advance %s receivable reduced (paid from the borrower''s wallet, ref %s)', a.reference, v_ref))),
    'special_advance:repayment:' || v_key, false);

  INSERT INTO public.special_advance_repayments (id, advance_id, amount, received_date, method, reference, note, idempotency_key,
                                                 ledger_group_id, recorded_by, proof_path)
  VALUES (v_rep, a.id, p_amount, v_today, 'wallet', v_ref, NULL, v_key, v_group, v_uid, NULL);
  PERFORM public._special_advance_apply_repayment(a.id, v_rep, p_amount);

  RETURN public._special_advance_wallet_receipt(v_rep) || jsonb_build_object('replayed', false);
END $function$;

CREATE OR REPLACE FUNCTION public.special_advance_record_correction(p_id uuid, p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_key text := btrim(COALESCE(p_request ->> 'idempotency_key', ''));
  v_kind text := p_request ->> 'kind';
  v_reason text := NULLIF(btrim(COALESCE(p_request ->> 'reason', '')), '');
  v_proof text := NULLIF(btrim(COALESCE(p_request ->> 'proof_path', '')), '');
  v_rep_id uuid;
  v_topup_id uuid;
  t public.special_advance_topups%ROWTYPE;
  v_avail numeric;
  a public.special_advances%ROWTYPE;
  r public.special_advance_repayments%ROWTYPE;
  e public.special_advance_corrections%ROWTYPE;
  v_amount bigint;
  v_id uuid := gen_random_uuid();
  v_ref text;
  v_today date := public._special_advance_kampala_today();
  v_src jsonb;
  v_legs jsonb;
  v_desc text;
  v_group uuid;
BEGIN
  PERFORM public._special_advance_require_mfa();
  IF length(v_key) NOT BETWEEN 16 AND 100 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  BEGIN v_rep_id := NULLIF(p_request ->> 'repayment_id', '')::uuid; EXCEPTION WHEN others THEN v_rep_id := NULL; END;
  BEGIN v_topup_id := NULLIF(p_request ->> 'topup_id', '')::uuid; EXCEPTION WHEN others THEN v_topup_id := NULL; END;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:correction:' || v_key, 0));
  SELECT * INTO e FROM public.special_advance_corrections WHERE idempotency_key = v_key;
  IF e.id IS NOT NULL THEN
    IF e.advance_id = p_id AND e.recorded_by = v_actor AND e.kind = v_kind AND e.repayment_id IS NOT DISTINCT FROM v_rep_id
       AND e.topup_id IS NOT DISTINCT FROM v_topup_id
       AND e.proof_path = v_proof AND e.reason = v_reason THEN
      RETURN public._special_advance_correction_json(e.id) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO a FROM public.special_advances WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF a.borrower_user_id = v_actor THEN
    RAISE EXCEPTION 'SELF_ADVANCE' USING ERRCODE = '42501';
  END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('repayment_reversal', 'payout_reversal', 'topup_reversal') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["kind"]';
  END IF;
  IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 20 AND 1000 THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023', DETAIL = 'Explain the error in 20 to 1000 characters';
  END IF;

  IF v_kind = 'repayment_reversal' THEN
    SELECT * INTO r FROM public.special_advance_repayments WHERE id = v_rep_id AND advance_id = a.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'REPAYMENT_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF r.reversed_by_correction IS NOT NULL THEN
      RAISE EXCEPTION 'REPAYMENT_ALREADY_REVERSED' USING ERRCODE = '22023';
    END IF;
    IF a.status NOT IN ('disbursed', 'settled') THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_CORRECTABLE' USING ERRCODE = '22023', DETAIL = a.status;
    END IF;
    IF a.status = 'settled' AND a.borrower_user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.special_advances o WHERE o.borrower_user_id = a.borrower_user_id AND o.id <> a.id
                    AND o.status IN ('pending_approval', 'approved', 'disbursed')) THEN
      RAISE EXCEPTION 'BORROWER_HAS_OPEN_ADVANCE' USING ERRCODE = '22023',
        DETAIL = 'Reopening this advance would give the borrower two open Special Advances';
    END IF;
    v_amount := r.amount;
  ELSIF v_kind = 'topup_reversal' THEN
    -- a top-up recorded in error (CFO, 12 Nov 2026): undo its payout, fee and receivable; it stays on record, reversed
    SELECT * INTO t FROM public.special_advance_topups WHERE id = v_topup_id AND advance_id = a.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'TOPUP_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF t.reversed_by_correction IS NOT NULL THEN
      RAISE EXCEPTION 'TOPUP_ALREADY_REVERSED' USING ERRCODE = '22023';
    END IF;
    IF a.status <> 'disbursed' THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_CORRECTABLE' USING ERRCODE = '22023', DETAIL = a.status;
    END IF;
    -- money already applied to the top-up's instalments must be reversed first (as for a payout reversal)
    IF EXISTS (SELECT 1 FROM public.special_advance_repayment_allocations x
                 JOIN public.special_advance_repayments rr ON rr.id = x.repayment_id AND rr.reversed_by_correction IS NULL
                 JOIN public.special_advance_instalments i ON i.advance_id = x.advance_id AND i.number = x.instalment_number
                WHERE x.advance_id = a.id AND i.topup_id = t.id) THEN
      RAISE EXCEPTION 'TOPUP_HAS_REPAYMENTS' USING ERRCODE = '22023';
    END IF;
    IF t.payout_method = 'wallet' THEN
      -- the money goes back out of the borrower's wallet: only what is available now, never an overdraft
      PERFORM 1 FROM public.wallet_balances_projection WHERE user_id = a.borrower_user_id FOR UPDATE;
      v_avail := COALESCE(public.get_user_available_balance__impl(a.borrower_user_id), 0);
      IF v_avail < t.principal THEN
        RAISE EXCEPTION 'TOPUP_FUNDS_NOT_IN_WALLET' USING ERRCODE = '22023',
          DETAIL = jsonb_build_object('available', v_avail, 'needed', t.principal)::text;
      END IF;
    END IF;
    v_amount := t.total_repayable;
  ELSE
    IF a.borrower_kind <> 'external' THEN  -- D11c: a wallet payout is not reversed here
      RAISE EXCEPTION 'PAYOUT_REVERSAL_NOT_SUPPORTED' USING ERRCODE = '22023',
        DETAIL = 'A payout to a Welile wallet cannot be reversed; only an external payout recorded in error';
    END IF;
    IF a.status <> 'disbursed' THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_CORRECTABLE' USING ERRCODE = '22023', DETAIL = a.status;
    END IF;
    IF EXISTS (SELECT 1 FROM public.special_advance_topups t2 WHERE t2.advance_id = a.id AND t2.reversed_by_correction IS NULL) THEN
      RAISE EXCEPTION 'PAYOUT_REVERSAL_HAS_TOPUP' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.special_advance_repayments x WHERE x.advance_id = a.id AND x.reversed_by_correction IS NULL) THEN
      RAISE EXCEPTION 'REPAYMENTS_MUST_BE_REVERSED_FIRST' USING ERRCODE = '22023';
    END IF;
    v_amount := a.total_repayable;
  END IF;
  v_proof := public._special_advance_check_proof(a.id, v_proof);  -- D11d

  v_ref := 'SAC-' || lpad(nextval('public.special_advance_correction_seq')::text, 6, '0');
  v_desc := format('Special Advance %s correction %s', a.reference, v_ref);
  v_src := jsonb_build_object('ledger_scope', 'platform', 'source_table', 'special_advance_corrections', 'source_id', v_id,
                              'reference_id', a.reference, 'currency', 'UGX',
                              'transaction_date', (v_today::timestamp AT TIME ZONE 'Africa/Kampala'));
  IF v_kind = 'repayment_reversal' AND r.method = 'wallet' THEN
    -- paid from the borrower's wallet: the money goes back to that wallet (CR L1) and the receivable is restored (DR A24)
    v_legs := jsonb_build_array(
      v_src || jsonb_build_object('direction', 'cash_out', 'amount', r.amount, 'category', 'special_advance_wallet_repayment',
                                  'description', format('%s: wallet repayment ref %s reversed (receivable restored)', v_desc, r.reference)),
      v_src || jsonb_build_object('ledger_scope', 'wallet', 'direction', 'cash_in', 'amount', r.amount, 'category', 'special_advance_wallet_repayment',
                                  'user_id', a.borrower_user_id, 'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
                                  'description', format('%s: wallet repayment ref %s returned to the borrower''s wallet', v_desc, r.reference)));
  ELSIF v_kind = 'repayment_reversal' THEN
    v_legs := jsonb_build_array(
      v_src || jsonb_build_object('direction', 'cash_out', 'amount', r.amount, 'category', 'special_advance_repayment_received',
                                  'description', format('%s: repayment ref %s reversed (company cash)', v_desc, r.reference)),
      v_src || jsonb_build_object('direction', 'cash_in', 'amount', r.amount, 'category', 'special_advance_repayment',
                                  'description', format('%s: repayment ref %s reversed (receivable restored)', v_desc, r.reference)));
  ELSIF v_kind = 'topup_reversal' THEN
    -- the opposite of the top-up's own legs
    v_legs := jsonb_build_array(
      v_src || jsonb_build_object('direction', 'cash_in', 'amount', t.principal, 'category', 'special_advance_receivable',
                                  'description', format('%s: top-up %s principal receivable reversed', v_desc, t.reference)));
    IF t.payout_method = 'wallet' THEN
      v_legs := v_legs || (v_src || jsonb_build_object('ledger_scope', 'wallet', 'direction', 'cash_out', 'amount', t.principal,
                                  'category', 'special_advance_credit', 'user_id', a.borrower_user_id, 'wallet_bucket', 'withdrawable',
                                  'recipient_type', 'user',
                                  'description', format('%s: top-up %s taken back from the borrower''s wallet', v_desc, t.reference)));
    ELSE
      v_legs := v_legs || (v_src || jsonb_build_object('direction', 'cash_out', 'amount', t.principal, 'category', 'special_advance_payout_cash',
                                  'description', format('%s: top-up %s payout ref %s reversed (company cash)', v_desc, t.reference, t.payout_reference)));
    END IF;
    IF t.access_fee > 0 THEN
      v_legs := v_legs
        || (v_src || jsonb_build_object('direction', 'cash_out', 'amount', t.access_fee, 'category', 'special_advance_fee_revenue',
                                        'description', format('%s: top-up %s access fee reversed', v_desc, t.reference)))
        || (v_src || jsonb_build_object('direction', 'cash_in', 'amount', t.access_fee, 'category', 'special_advance_receivable',
                                        'description', format('%s: top-up %s access fee receivable reversed', v_desc, t.reference)));
    END IF;
  ELSE
    v_legs := jsonb_build_array(
      v_src || jsonb_build_object('direction', 'cash_out', 'amount', a.principal, 'category', 'special_advance_payout_cash',
                                  'description', format('%s: payout ref %s reversed (company cash)', v_desc, a.payout_reference)),
      v_src || jsonb_build_object('direction', 'cash_in', 'amount', a.principal, 'category', 'special_advance_receivable',
                                  'description', v_desc || ': principal receivable reversed'));
    -- one access fee (CFO decision 2026-11-03), as posted at payout
    IF a.access_fee + a.registration_fee > 0 THEN
      v_legs := v_legs
        || (v_src || jsonb_build_object('direction', 'cash_out', 'amount', a.access_fee + a.registration_fee, 'category', 'special_advance_fee_revenue',
                                        'description', v_desc || ': access fee reversed'))
        || (v_src || jsonb_build_object('direction', 'cash_in', 'amount', a.access_fee + a.registration_fee, 'category', 'special_advance_receivable',
                                        'description', v_desc || ': access fee receivable reversed'));
    END IF;
  END IF;

  -- one key per correction: it can post only once
  v_group := public.create_ledger_transaction(v_legs, 'special_advance:correction:' || v_id::text, false);

  INSERT INTO public.special_advance_corrections (id, reference, advance_id, kind, repayment_id, topup_id, amount, reason, proof_path,
                                                  idempotency_key, ledger_group_id, recorded_by)
  VALUES (v_id, v_ref, a.id, v_kind, CASE WHEN v_kind = 'repayment_reversal' THEN r.id END,
          CASE WHEN v_kind = 'topup_reversal' THEN t.id END, v_amount, v_reason, v_proof,
          v_key, v_group, v_actor);
  INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
  VALUES (a.id, 'correction_posted', a.status, a.status, v_actor, v_reason,
          jsonb_build_object('correction_id', v_id, 'kind', v_kind, 'amount', v_amount, 'repayment_id', r.id, 'topup_id', t.id,
                             'ledger_group_id', v_group));

  PERFORM set_config('special_advance.correction', v_id::text, true);
  IF v_kind = 'repayment_reversal' THEN
    UPDATE public.special_advance_repayments SET reversed_by_correction = v_id WHERE id = r.id;
    IF a.status = 'settled' THEN
      UPDATE public.special_advances SET status = 'disbursed', settled_at = NULL WHERE id = a.id;
    END IF;
  ELSIF v_kind = 'topup_reversal' THEN
    UPDATE public.special_advance_topups SET reversed_by_correction = v_id WHERE id = t.id;
    -- a new version of the advance; it settles if the top-up was all that was left
    IF (public._special_advance_position(a.id) ->> 'outstanding')::bigint = 0 THEN
      UPDATE public.special_advances SET status = 'settled', settled_at = clock_timestamp() WHERE id = a.id;
    ELSE
      UPDATE public.special_advances SET updated_at = clock_timestamp() WHERE id = a.id;
    END IF;
  ELSE
    UPDATE public.special_advances SET status = 'reversed' WHERE id = a.id;
  END IF;
  PERFORM set_config('special_advance.correction', '', true);

  RETURN public._special_advance_correction_json(v_id) || jsonb_build_object('replayed', false);
END $function$;

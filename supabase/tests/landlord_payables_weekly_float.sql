-- Rolled-back verification for 20261021100000_landlord_payables_weekly_float.sql (needs Parts 1 and 2 first).
--
-- Run against the database AFTER the migration. Everything happens inside one block that ends in
-- RAISE EXCEPTION, so nothing is kept. The error text IS the report: a JSON list of steps, each with
-- "pass": true/false.
--
-- It never inserts payouts or withdrawals (those tables carry money triggers). It reads the real payouts and
-- only writes provider evidence (statement imports), which the final RAISE rolls back. Checks:
--   1  v_landlord_payout_settlement has exactly one row per landlord payout
--   2  the landlord rows on v_payables_lines are exactly the paid-out, unconfirmed payouts, at their amounts
--   3  landlord payment history holds exactly the provider-confirmed payouts
--   4  importing a statement line with a payable payout's transaction ID and amount confirms it: it leaves the list
--   5  importing the same file again is refused as already imported
--   6  statement lines cannot be edited
--   7  voiding the import puts the payout back on the list
--   8  get_landlord_payables_by_week totals reconcile with the payables list, and review amounts never overlap payable
--      (payable_under_review is part of payable; review_only = confirmed + not paid under review, outside payable)
--   9  exceptions agree with the data: paid_amount_differs exactly where the withdrawal paid another amount,
--      reference_unusable exactly where an unconfirmed paid-out payout has a reference that is not 11 (MTN) or 12 (Airtel) digits,
--      shared_reference exactly where an unconfirmed paid-out payout shares its reference,
--      evidence_conflict exactly where a live failed/reversed/pending statement line carries a paid-out payout's reference
--      (a pending line later resolved by a success on the same channel and account is not a conflict), and such a
--      conflict never turns an SMS-confirmed payout back into a payable; no payout is confirmed by a statement line
--      alone when its reference is invalid or shared
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_cfo uuid;
  v_n bigint; v_m bigint; v_a numeric; v_b numeric;
  v_payout uuid; v_ref text; v_amt numeric;
  v_sha text := md5(random()::text) || md5(random()::text);
  v_res jsonb; v_imp uuid; v_state text; v_json jsonb;
BEGIN
  SELECT ur.user_id INTO v_cfo FROM public.user_roles ur WHERE ur.role::text = 'cfo' LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_cfo::text, ''), true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_cfo)::text, true);

  -- 1
  SELECT count(*), count(DISTINCT payout_id) INTO v_n, v_m FROM public.v_landlord_payout_settlement;
  r := r || jsonb_build_object('step', 1, 'pass', v_n = v_m AND v_n = (SELECT count(*) FROM public.landlord_payouts), 'rows', v_n);

  -- 2
  SELECT count(*), COALESCE(sum(outstanding_amount), 0) INTO v_n, v_a FROM public.v_payables_lines WHERE category_key = 'landlord';
  SELECT count(*), COALESCE(sum(GREATEST(amount, 0)), 0) INTO v_m, v_b FROM public.v_landlord_payout_settlement WHERE state = 'paid_unconfirmed' AND amount > 0;
  r := r || jsonb_build_object('step', 2, 'pass', v_n = v_m AND v_a = v_b
        AND NOT EXISTS (SELECT 1 FROM public.v_payables_lines l
                         WHERE l.category_key = 'landlord'
                           AND NOT EXISTS (SELECT 1 FROM public.v_landlord_payout_settlement s WHERE s.payout_id = l.item_id AND s.state = 'paid_unconfirmed')),
        'list_rows', v_n, 'list_amount', v_a);

  -- 3
  SELECT count(*), COALESCE(sum(amount), 0) INTO v_n, v_a FROM public.v_payables_payment_history WHERE category_key = 'landlord';
  SELECT count(*), COALESCE(sum(amount), 0) INTO v_m, v_b FROM public.v_landlord_payout_settlement WHERE state = 'confirmed';
  r := r || jsonb_build_object('step', 3, 'pass', v_n = v_m AND v_a = v_b, 'history_rows', v_n, 'confirmed', v_m);

  -- 4: pick a payable payout with a usable reference and no statement line yet
  SELECT s.payout_id, s.payout_reference, s.amount INTO v_payout, v_ref, v_amt
    FROM public.v_landlord_payout_settlement s
   WHERE s.state = 'paid_unconfirmed' AND s.exception IS NULL AND length(COALESCE(s.payout_reference, '')) >= 6
     AND NOT EXISTS (SELECT 1 FROM public.provider_statement_lines l WHERE l.tid_normalized = s.payout_reference)
     AND NOT EXISTS (SELECT 1 FROM public.v_landlord_payout_settlement o WHERE o.payout_reference = s.payout_reference AND o.payout_id <> s.payout_id)
   ORDER BY s.paid_at DESC NULLS LAST LIMIT 1;
  IF v_payout IS NULL THEN
    r := r || jsonb_build_object('step', 4, 'pass', true, 'note', 'no payable payout with a reference to test against');
  ELSE
    v_res := public.import_provider_statement('mtn_momo', 'TEST (rolled back)', 'verification.csv', v_sha,
               jsonb_build_array(jsonb_build_object('transaction_id', v_ref, 'direction', 'out', 'status', 'successful', 'amount', v_amt, 'tx_at', now())));
    v_imp := (v_res->>'import_id')::uuid;
    SELECT state INTO v_state FROM public.v_landlord_payout_settlement WHERE payout_id = v_payout;
    r := r || jsonb_build_object('step', 4, 'pass', (v_res->>'inserted')::int = 1 AND v_state = 'confirmed'
          AND NOT EXISTS (SELECT 1 FROM public.v_payables_lines WHERE category_key = 'landlord' AND item_id = v_payout),
          'state', v_state);
  END IF;

  -- 5
  IF v_imp IS NOT NULL THEN
    v_res := public.import_provider_statement('mtn_momo', 'TEST (rolled back)', 'verification.csv', v_sha,
               jsonb_build_array(jsonb_build_object('transaction_id', v_ref, 'direction', 'out', 'status', 'successful', 'amount', v_amt, 'tx_at', now())));
    r := r || jsonb_build_object('step', 5, 'pass', (v_res->>'already_imported')::boolean AND (v_res->>'import_id')::uuid = v_imp);
  ELSE
    r := r || jsonb_build_object('step', 5, 'pass', true, 'note', 'skipped with step 4');
  END IF;

  -- 6
  BEGIN
    UPDATE public.provider_statement_lines SET amount = amount + 1 WHERE import_id = v_imp;
    IF v_imp IS NULL THEN
      r := r || jsonb_build_object('step', 6, 'pass', true, 'note', 'skipped with step 4');
    ELSE
      r := r || jsonb_build_object('step', 6, 'pass', false, 'got', 'line edited');
    END IF;
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 6, 'pass', SQLERRM LIKE '%cannot be changed%', 'got', SQLERRM); END;

  -- 7
  IF v_imp IS NOT NULL THEN
    PERFORM public.void_provider_statement_import(v_imp, 'rolled-back verification');
    SELECT state INTO v_state FROM public.v_landlord_payout_settlement WHERE payout_id = v_payout;
    r := r || jsonb_build_object('step', 7, 'pass', v_state = 'paid_unconfirmed'
          AND EXISTS (SELECT 1 FROM public.v_payables_lines WHERE category_key = 'landlord' AND item_id = v_payout), 'state', v_state);
  ELSE
    r := r || jsonb_build_object('step', 7, 'pass', true, 'note', 'skipped with step 4');
  END IF;

  -- 8
  BEGIN
    v_json := public.get_landlord_payables_by_week();
    SELECT COALESCE(sum(outstanding_amount), 0) INTO v_a FROM public.v_payables_lines WHERE category_key = 'landlord';
    r := r || jsonb_build_object('step', 8, 'pass', (v_json#>>'{totals,payable}')::numeric = v_a
          AND (v_json#>>'{totals,payable_with_weekly_float}')::numeric + (v_json#>>'{totals,payable_without_weekly_float}')::numeric = v_a
          AND (v_json#>>'{totals,payable_under_review}')::numeric <= v_a
          AND (v_json#>>'{totals,payable_under_review}')::numeric = (SELECT COALESCE(sum(amount), 0) FROM public.v_landlord_payout_settlement
                WHERE state = 'paid_unconfirmed' AND exceptions && ARRAY['failed_but_paid','completed_without_payout','evidence_conflict','statement_match_unreliable','paid_amount_differs','reference_unusable','shared_evidence','shared_reference'])
          AND (v_json#>>'{totals,review_only}')::numeric = (v_json#>>'{totals,confirmed_under_review}')::numeric + (v_json#>>'{totals,not_paid_under_review}')::numeric
          AND NOT (v_json->'totals' ? 'exception_amount'),
          'totals', v_json->'totals');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 8, 'pass', false, 'got', SQLERRM); END;

  -- 9
  WITH s AS MATERIALIZED (
         SELECT v.*, count(*) FILTER (WHERE v.payout_reference IS NOT NULL) OVER (PARTITION BY v.payout_reference) AS ref_payouts
           FROM public.v_landlord_payout_settlement v),
       bad AS (
         SELECT count(*) FILTER (WHERE ('paid_amount_differs' = ANY (exceptions))
                                    <> (paid_out AND paid_amount IS NOT NULL AND paid_amount <> amount)) AS amount_mismatch,
                count(*) FILTER (WHERE ('reference_unusable' = ANY (exceptions))
                                    <> (state = 'paid_unconfirmed' AND length(COALESCE(payout_reference, '')) NOT IN (11, 12))) AS ref_mismatch,
                count(*) FILTER (WHERE ('shared_reference' = ANY (exceptions))
                                    <> (state = 'paid_unconfirmed' AND payout_reference IS NOT NULL AND ref_payouts > 1)) AS shared_mismatch,
                count(*) FILTER (WHERE exception IS DISTINCT FROM exceptions[1]) AS primary_mismatch,
                count(*) FILTER (WHERE ('evidence_conflict' = ANY (exceptions))
                                    <> (paid_out AND EXISTS (SELECT 1 FROM public.provider_statement_lines l
                                                              WHERE l.tid_normalized = s.payout_reference AND l.voided_at IS NULL
                                                                AND l.status IN ('failed', 'reversed', 'pending')
                                                                AND NOT (l.status = 'pending' AND EXISTS (
                                                                      SELECT 1 FROM public.provider_statement_lines s2
                                                                       WHERE s2.tid_normalized = l.tid_normalized AND s2.voided_at IS NULL
                                                                         AND s2.status = 'successful' AND s2.direction = 'out'
                                                                         AND s2.channel = l.channel AND s2.account_ref = l.account_ref
                                                                         AND s2.tx_at >= l.tx_at))))) AS conflict_mismatch,
                count(*) FILTER (WHERE 'evidence_conflict' = ANY (exceptions) AND evidence_source = 'provider_email'
                                   AND state <> 'confirmed') AS sms_reopened,
                count(*) FILTER (WHERE state = 'confirmed' AND evidence_source = 'statement'
                                   AND (length(COALESCE(payout_reference, '')) NOT IN (11, 12) OR ref_payouts > 1)) AS unreliable_statement_confirmed
           FROM s)
  SELECT jsonb_build_object('step', 9, 'pass', amount_mismatch + ref_mismatch + shared_mismatch + primary_mismatch + conflict_mismatch + sms_reopened + unreliable_statement_confirmed = 0,
           'mismatches', jsonb_build_object('paid_amount_differs', amount_mismatch, 'reference_unusable', ref_mismatch,
                                            'shared_reference', shared_mismatch, 'primary', primary_mismatch,
                                            'evidence_conflict', conflict_mismatch, 'sms_reopened', sms_reopened,
                                            'unreliable_statement_confirmed', unreliable_statement_confirmed),
           'flagged', (SELECT jsonb_object_agg(e, n) FROM (SELECT unnest(exceptions) e, count(*) n FROM s GROUP BY 1) x))
    INTO v_json FROM bad;
  r := r || v_json;

  RAISE EXCEPTION 'landlord_payables_weekly_float verification (rolled back): %', r;
END
$test$;

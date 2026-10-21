-- Rolled-back verification for 20261021235000_landlord_payables_weekly_float.sql (needs Parts 1 and 2 first).
--
-- Run against the database AFTER the migration. It is READ-ONLY: it only SELECTs (no table, temp table or row is
-- created or written) and can be run inside BEGIN TRANSACTION READ ONLY. The block ends in RAISE EXCEPTION; the error
-- text IS the report: a JSON list of 13 steps, each with "pass": true/false. Checks:
--   1  v_landlord_payout_settlement has exactly one row per landlord payout
--   2  the landlord rows on v_payables_lines are exactly (a) the weekly floats with an outstanding allowance (or
--      overspent), at outstanding_amount, and (b) one row per payout approved but not yet paid out that sits in no weekly
--      float, at its amount; (b) is re-derived from the base tables (no completed withdrawal, no FinOps disbursement with
--      a reference, no live allocation in a week that has a current weekly float, status neither completed nor failed)
--   3  landlord payment history holds exactly the confirmed payouts, dated by the payout record (never the upload time)
--   4  STRICT RULE, re-derived from the base tables: every confirmed payout has a completed linked withdrawal with a
--      receipt token and an accessible file, whose latest check of that exact file is 'match', with a transaction ID
--      read equal to the withdrawal reference (11 or 12 digits) and an amount read equal to the withdrawal and payout
--      amounts, no other payout or withdrawal using that ID or reference, and no blocking open alert
--   5  only Receipt Archive evidence confirms: no confirmed payout lacks a withdrawal, receipt token, accessible file,
--      'match' check, read ID or read amount
--   6  historical review: exactly the paid-out, unverified payouts made without a weekly float
--   7  get_landlord_payables_by_week groups do not overlap and reconcile by count and amount:
--      confirmed + in_float_unverified + historical_review + review_only + not_paid = all payouts;
--      float_payable + approved_no_float = landlord_payable = the landlord rows on the payables list
--   8  the floats array adds up to the same totals
--   9  exceptions agree with the data (primary = first; paid_amount_differs, reference_unusable, shared_reference)
--  10  landlord_receipt_reversed is set exactly when the payout's CURRENT Welile landlord receipt (its own receipt followed
--      forward through replaces_receipt_id) is reversed or refunded; it is a flag only (a flagged confirmed payout stays
--      confirmed, a flagged historical payout stays historical)
--  11  scope: the payables list and history hold only Supporter Returns (partner), the landlord float payout budget,
--      agent commissions and departmental budgets; no wallet, withdrawal-request, agent-float or payroll rows; the
--      category frame lists exactly those four (and 'other')
--  12  each float re-derived from the base tables: allowance = float + live miscellaneous allocations; verified = confirmed
--      payouts allocated to that week; while the week is open outstanding = max(allowance - verified, 0); after it
--      ends outstanding = max(live approvals - verified, 0) and the rest of the allowance is lapsed_unused (never payable)
--  13  the payables forecast models new obligations only for the four payables: no withdrawal-request, payroll or
--      per-payout landlord stream in its definition or its output, and no landlord originations on top of the float lines;
--      no landlord run-off stream; every period flags weeks without a weekly float as not estimated (never a covered zero);
--      landlord_coverage carries that note and the historical-review totals
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_cfo uuid;
  v_n bigint; v_m bigint; v_a numeric; v_b numeric;
  v_json jsonb; v_t jsonb; v_err text;
BEGIN
  SELECT ur.user_id INTO v_cfo FROM public.user_roles ur WHERE ur.role::text = 'cfo' LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_cfo::text, ''), true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_cfo)::text, true);

  -- 1
  SELECT count(*), count(DISTINCT payout_id) INTO v_n, v_m FROM public.v_landlord_payout_settlement;
  r := r || jsonb_build_object('step', 1, 'pass', v_n = v_m AND v_n = (SELECT count(*) FROM public.landlord_payouts), 'rows', v_n);

  -- 2
  SELECT count(*), COALESCE(sum(outstanding_amount), 0) INTO v_n, v_a FROM public.v_payables_lines WHERE category_key = 'landlord';
  SELECT count(*), COALESCE(sum(outstanding_amount), 0) INTO v_m, v_b
    FROM (SELECT outstanding_amount FROM public.v_landlord_float_payables WHERE outstanding_amount > 0 OR overspent
          UNION ALL
          -- approved, not yet paid out, in no weekly float: re-derived from the base tables, not from the view's flag
          SELECT lp.amount FROM public.landlord_payouts lp
           WHERE COALESCE(lp.status, '') NOT IN ('completed', 'failed') AND lp.amount > 0
             AND NOT EXISTS (SELECT 1 FROM public.withdrawal_requests w WHERE w.landlord_payout_id = lp.id AND w.status = 'completed')
             AND NOT (NULLIF(regexp_replace(COALESCE(lp.finops_momo_reference, ''), '[^0-9]', '', 'g'), '') IS NOT NULL
                      AND lp.finops_disbursed_at IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM public.landlord_float_budget_allocations a
                              JOIN public.landlord_float_budgets b ON b.period_type = 'weekly' AND b.superseded_at IS NULL
                                                                  AND b.period_start = a.week_start
                              WHERE a.rent_request_id = lp.rent_request_id AND a.released_at IS NULL)) x;
  r := r || jsonb_build_object('step', 2, 'pass', v_n = v_m AND v_a = v_b
        AND NOT EXISTS (SELECT 1 FROM public.v_payables_lines l
                         WHERE l.category_key = 'landlord'
                           AND NOT EXISTS (SELECT 1 FROM public.v_landlord_float_payables f
                                            WHERE l.product_key IN ('landlord_float_budget', 'landlord_float_overspent')
                                              AND f.float_id = l.item_id AND f.outstanding_amount = l.outstanding_amount)
                           AND NOT EXISTS (SELECT 1 FROM public.v_landlord_payout_settlement s
                                            WHERE l.product_key = 'landlord_approved_no_float' AND s.approved_no_float
                                              AND NOT s.has_weekly_float AND s.payout_id = l.item_id AND s.amount = l.outstanding_amount)),
        'list_rows', v_n, 'list_amount', v_a, 'expected_rows', v_m, 'expected_amount', v_b);

  -- 3
  WITH s AS (SELECT * FROM public.v_landlord_payout_settlement)
  SELECT jsonb_build_object('step', 3, 'pass',
        (SELECT count(*) FROM public.v_payables_payment_history WHERE category_key = 'landlord') = (SELECT count(*) FROM s WHERE state = 'confirmed')
    AND (SELECT COALESCE(sum(amount), 0) FROM public.v_payables_payment_history WHERE category_key = 'landlord')
        = (SELECT COALESCE(sum(amount), 0) FROM s WHERE state = 'confirmed')
    AND NOT EXISTS (SELECT 1 FROM s WHERE state = 'confirmed' AND paid_date IS DISTINCT FROM (paid_at AT TIME ZONE 'Africa/Kampala')::date)
    AND NOT EXISTS (SELECT 1 FROM s WHERE state = 'confirmed' AND paid_date_source NOT IN ('withdrawal_completed', 'finops_disbursed')))
    INTO v_json;
  r := r || v_json;

  -- 4: re-derive every check from the base tables for every confirmed payout
  WITH s AS (SELECT * FROM public.v_landlord_payout_settlement)
  SELECT count(*) INTO v_n
    FROM s
    JOIN public.withdrawal_requests w ON w.id = s.withdrawal_id
   WHERE s.state = 'confirmed'
     AND NOT (
           w.status = 'completed' AND w.landlord_payout_id = s.payout_id
       AND w.receipt_token IS NOT NULL AND w.payout_proof_path IS NOT NULL
       AND EXISTS (SELECT 1 FROM storage.objects so
                    WHERE so.bucket_id = COALESCE(w.payout_proof_bucket, 'payment-proofs') AND so.name = w.payout_proof_path)
       AND COALESCE((SELECT o.validation_result = 'match'
                       AND regexp_replace(COALESCE(o.extracted_tid, ''), '[^0-9]', '', 'g')
                           = regexp_replace(COALESCE(NULLIF(w.transaction_id, ''), w.fin_ops_reference, ''), '[^0-9]', '', 'g')
                       AND length(regexp_replace(COALESCE(o.extracted_tid, ''), '[^0-9]', '', 'g')) IN (11, 12)
                       AND o.extracted_amount IS NOT NULL
                       AND round(o.extracted_amount) = round(w.amount) AND round(w.amount) = round(s.amount)
                      FROM public.payout_proof_ocr_log o
                     WHERE o.withdrawal_request_id = w.id AND o.storage_path = w.payout_proof_path
                     ORDER BY o.created_at DESC LIMIT 1), false)
       AND NOT EXISTS (SELECT 1 FROM public.payout_proof_integrity_alerts a
                        WHERE a.withdrawal_id = w.id AND NOT a.resolved AND a.issue_type <> 'proof_missing')
       AND NOT EXISTS (SELECT 1 FROM public.withdrawal_requests w2
                        WHERE w2.status = 'completed' AND w2.id <> w.id AND w2.landlord_payout_id IS DISTINCT FROM s.payout_id
                          AND regexp_replace(COALESCE(NULLIF(w2.transaction_id, ''), w2.fin_ops_reference, ''), '[^0-9]', '', 'g') = s.receipt_tid_read)
       AND NOT EXISTS (SELECT 1 FROM s o2 WHERE o2.payout_id <> s.payout_id AND o2.payout_reference = s.payout_reference));
  SELECT count(*) FILTER (WHERE state = 'confirmed'), count(*) FILTER (WHERE state = 'confirmed' AND withdrawal_id IS NULL)
    INTO v_m, v_b FROM public.v_landlord_payout_settlement;
  r := r || jsonb_build_object('step', 4, 'pass', v_n = 0 AND v_b = 0, 'confirmed', v_m, 'failing_strict_rule', v_n);

  -- 5
  r := r || jsonb_build_object('step', 5, 'pass', NOT EXISTS (
        SELECT 1 FROM public.v_landlord_payout_settlement
         WHERE state = 'confirmed'
           AND (withdrawal_id IS NULL OR receipt_token IS NULL OR receipt_check_id IS NULL OR receipt_check_result <> 'match'
                OR receipt_tid_read IS NULL OR receipt_amount_read IS NULL OR NOT receipt_file_accessible)));

  -- 6
  SELECT count(*) FILTER (WHERE state = 'historical_review'),
         count(*) FILTER (WHERE (state = 'historical_review') <> (paid_out AND NOT receipt_verified AND NOT has_weekly_float))
    INTO v_n, v_m FROM public.v_landlord_payout_settlement;
  r := r || jsonb_build_object('step', 6, 'pass', v_m = 0, 'historical_review', v_n);

  -- 7 and 8 both read get_landlord_payables_by_week; if it fails, both steps fail with its error.
  BEGIN
    v_json := public.get_landlord_payables_by_week();
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  v_t := v_json->'totals';

  -- 7
  r := r || jsonb_build_object('step', 7, 'pass', v_err IS NULL AND (
          (v_t->>'confirmed_count')::bigint + (v_t->>'in_float_unverified_count')::bigint + (v_t->>'historical_review_count')::bigint
            + (v_t->>'review_only_count')::bigint + (v_t->>'not_paid_count')::bigint = (v_t->>'payouts')::bigint
      AND (v_t->>'confirmed')::numeric + (v_t->>'in_float_unverified')::numeric + (v_t->>'historical_review')::numeric
            + (v_t->>'review_only')::numeric + (v_t->>'not_paid')::numeric = (v_t->>'payouts_amount')::numeric
      AND (v_t->>'payouts')::bigint = (SELECT count(*) FROM public.landlord_payouts)
      AND (v_t->>'in_float_unverified')::numeric = (v_t->>'unverified_paid')::numeric
      AND (v_t->>'float_payable')::numeric + (v_t->>'approved_no_float')::numeric = (v_t->>'landlord_payable')::numeric
      AND (v_t->>'landlord_payable')::numeric = (SELECT COALESCE(sum(outstanding_amount), 0) FROM public.v_payables_lines WHERE category_key = 'landlord')
      AND (v_t->>'approved_no_float_count')::bigint = (SELECT count(*) FROM public.v_payables_lines WHERE product_key = 'landlord_approved_no_float')),
      'totals', v_t, 'error', v_err);

  -- 8
  r := r || jsonb_build_object('step', 8, 'pass', v_err IS NULL AND (
          (SELECT COALESCE(sum((x->>'outstanding_amount')::numeric), 0) FROM jsonb_array_elements(v_json->'floats') x) = (v_t->>'float_payable')::numeric
      AND (SELECT COALESCE(sum((x->>'allowance')::numeric), 0) FROM jsonb_array_elements(v_json->'floats') x) = (v_t->>'allowance')::numeric
      AND (SELECT COALESCE(sum((x->>'verified_paid')::numeric), 0) FROM jsonb_array_elements(v_json->'floats') x) = (v_t->>'verified_paid')::numeric
      AND (SELECT COALESCE(sum((x->>'amount')::numeric), 0) FROM jsonb_array_elements(v_json->'historical_by_week') x) = (v_t->>'historical_review')::numeric),
      'error', v_err);

  -- 9
  WITH s AS (SELECT * FROM public.v_landlord_payout_settlement)
  SELECT jsonb_build_object('step', 9, 'pass',
        NOT EXISTS (SELECT 1 FROM s WHERE exception IS DISTINCT FROM exceptions[1])
    AND NOT EXISTS (SELECT 1 FROM s WHERE ('paid_amount_differs' = ANY (exceptions)) <> (paid_out AND paid_amount IS NOT NULL AND paid_amount <> amount))
    AND NOT EXISTS (SELECT 1 FROM s WHERE ('reference_unusable' = ANY (exceptions))
                                        <> (paid_out AND NOT receipt_verified AND length(COALESCE(payout_reference, '')) NOT IN (11, 12)))
    AND NOT EXISTS (SELECT 1 FROM s s1 WHERE ('shared_reference' = ANY (s1.exceptions))
                                           <> (s1.paid_out AND NOT s1.receipt_verified AND s1.payout_reference IS NOT NULL
                                               AND (SELECT count(*) FROM s s2 WHERE s2.payout_reference = s1.payout_reference) > 1)),
    'flagged', (SELECT jsonb_object_agg(e, n) FROM (SELECT unnest(exceptions) e, count(*) n FROM s GROUP BY 1) x))
    INTO v_json;
  r := r || v_json;

  -- 10: re-derive the current receipt of each payout independently (forward through replacements, cycle-guarded)
  WITH RECURSIVE walk AS (
    SELECT r0.payout_id, r0.id, 0 AS depth, ARRAY[r0.id] AS path FROM public.landlord_payout_receipts r0
    UNION ALL
    SELECT w.payout_id, n.id, w.depth + 1, w.path || n.id
      FROM walk w JOIN public.landlord_payout_receipts n ON n.replaces_receipt_id = w.id
     WHERE w.depth < 20 AND NOT (n.id = ANY (w.path))),
  cur AS (
    SELECT DISTINCT ON (w.payout_id) w.payout_id,
           (r1.reversed_at IS NOT NULL OR r1.status IN ('reversed', 'refunded')) AS reversed
      FROM walk w JOIN public.landlord_payout_receipts r1 ON r1.id = w.id
     ORDER BY w.payout_id, w.depth DESC, r1.created_at DESC),
  s AS (SELECT * FROM public.v_landlord_payout_settlement)
  SELECT jsonb_build_object('step', 10, 'pass',
        NOT EXISTS (SELECT 1 FROM s LEFT JOIN cur c ON c.payout_id = s.payout_id
                     WHERE s.landlord_receipt_reversed <> COALESCE(c.reversed, false)
                        OR ('landlord_receipt_reversed' = ANY (s.exceptions)) <> s.landlord_receipt_reversed)
    AND NOT EXISTS (SELECT 1 FROM s WHERE landlord_receipt_reversed AND paid_out AND receipt_verified AND state <> 'confirmed')
    AND NOT EXISTS (SELECT 1 FROM s WHERE landlord_receipt_reversed AND paid_out AND NOT receipt_verified
                                        AND NOT has_weekly_float AND state <> 'historical_review'),
    'flagged', (SELECT count(*) FROM s WHERE landlord_receipt_reversed))
    INTO v_json;
  r := r || v_json;

  -- 11
  r := r || jsonb_build_object('step', 11, 'pass',
        NOT EXISTS (SELECT 1 FROM public.v_payables_lines WHERE category_key NOT IN ('partner', 'landlord', 'agent', 'budget')
                                                             OR product_key = 'agent_float_withdrawal')
    AND NOT EXISTS (SELECT 1 FROM public.v_payables_payment_history WHERE category_key NOT IN ('partner', 'landlord', 'agent', 'budget')
                                                                       OR product_key = 'agent_float_withdrawal')
    AND (SELECT string_agg(category_key, ',' ORDER BY sort_order) FROM public.payables_category_frame()) = 'partner,landlord,agent,budget,other',
    'categories', (SELECT jsonb_object_agg(category_key, n) FROM (SELECT category_key, count(*) n FROM public.v_payables_lines GROUP BY 1) x));

  -- 12: re-derive each float from the base tables
  WITH b AS (SELECT id, period_start, period_end, amount FROM public.landlord_float_budgets WHERE period_type = 'weekly' AND superseded_at IS NULL),
  d AS (
    SELECT b.id, b.period_end < (now() AT TIME ZONE 'Africa/Kampala')::date AS ended,
           COALESCE((SELECT sum(a.amount) FROM public.landlord_float_budget_allocations a
                      WHERE a.week_start = b.period_start AND a.released_at IS NULL), 0) AS approved,
           b.amount + COALESCE((SELECT sum(a.amount) FROM public.landlord_float_budget_allocations a
                                 WHERE a.week_start = b.period_start AND a.kind = 'miscellaneous' AND a.released_at IS NULL), 0) AS allowance,
           COALESCE((SELECT sum(s.amount) FROM public.v_landlord_payout_settlement s
                      WHERE s.state = 'confirmed' AND s.has_weekly_float AND s.float_week_start = b.period_start), 0) AS verified
      FROM b)
  SELECT jsonb_build_object('step', 12, 'pass',
        (SELECT count(*) FROM public.v_landlord_float_payables) = (SELECT count(*) FROM d)
    AND NOT EXISTS (SELECT 1 FROM d LEFT JOIN public.v_landlord_float_payables f ON f.float_id = d.id
                     WHERE f.float_id IS NULL OR f.allowance <> d.allowance OR f.verified_paid <> d.verified
                        OR f.outstanding_amount <> CASE WHEN d.ended THEN GREATEST(d.approved - d.verified, 0)
                                                        ELSE GREATEST(d.allowance - d.verified, 0) END
                        OR f.lapsed_unused <> CASE WHEN d.ended THEN GREATEST(d.allowance - GREATEST(d.approved, d.verified), 0) ELSE 0 END
                        OR f.week_ended <> d.ended
                        OR f.overspent <> (d.verified > d.allowance)),
    'floats', (SELECT count(*) FROM d))
    INTO v_json;
  r := r || v_json;

  -- 13
  BEGIN
    v_json := public.get_payables_predictive_forecast('week', 8);
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN
    v_json := NULL; v_err := SQLERRM;
  END;
  WITH src AS (SELECT s FROM jsonb_array_elements(COALESCE(v_json->'periods', '[]'::jsonb)) p, jsonb_array_elements(p->'sources') s)
  SELECT jsonb_build_object('step', 13, 'pass', v_err IS NULL
    AND (SELECT position('Payables scope (CFO, 2026-10-21)' IN prosrc) > 0
                AND prosrc !~ '''(withdrawal_request|payroll_disbursement|agent_landlord_payout)'''
           FROM pg_proc WHERE oid = 'public.get_payables_predictive_forecast(text,integer,date)'::regprocedure)
    AND NOT EXISTS (SELECT 1 FROM src WHERE s->>'category_key' NOT IN ('partner', 'landlord', 'agent', 'budget')
                                         OR s->>'product_key' IN ('withdrawal_request', 'payroll_disbursement', 'agent_float_withdrawal'))
    AND NOT EXISTS (SELECT 1 FROM src WHERE s->>'category_key' = 'landlord' AND (s->>'new_origination')::numeric <> 0)
    AND NOT EXISTS (SELECT 1 FROM src WHERE s->>'product_key' IN ('landlord_payout', 'agent_landlord_payout'))
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_json->'streams') x WHERE x->>'category_key' = 'landlord')
    -- every period says whether its landlord weeks are covered by a weekly float; uncovered weeks are flagged, not zero
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_json->'periods') p
                     WHERE p->'landlord_float' IS NULL
                        OR (p->'landlord_float'->>'landlord_not_estimated')::boolean
                           <> (jsonb_array_length(p->'landlord_float'->'weeks_without_float') > 0)
                        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p->'landlord_float'->'weeks_without_float') w
                                    WHERE EXISTS (SELECT 1 FROM public.v_landlord_float_payables f WHERE f.week_start = w::date)))
    AND v_json->'landlord_coverage'->>'note' LIKE '%not estimated%'
    -- forecast reconciles to the payables list, and every ended float still outstanding is carried (overdue) and listed
    AND (v_json->'reconciliation'->>'difference')::numeric = 0
    AND (v_json->'reconciliation'->>'payables_total')::numeric = (SELECT COALESCE(sum(outstanding_amount), 0) FROM public.v_payables_lines)
    AND (SELECT COALESCE(sum(outstanding_amount), 0) FROM public.v_landlord_float_payables
          WHERE week_end < (now() AT TIME ZONE 'Africa/Nairobi')::date)
        = (SELECT COALESCE(sum((s->>'amount')::numeric), 0) FROM src WHERE s->>'product_key' = 'landlord_float_budget' AND s->>'basis' = 'overdue')
    AND (SELECT count(*) FROM public.v_landlord_float_payables
          WHERE week_end < (now() AT TIME ZONE 'Africa/Nairobi')::date AND outstanding_amount > 0)
        = jsonb_array_length(v_json->'landlord_coverage'->'overdue_floats')
    AND (v_json->'landlord_coverage'->>'historical_review_amount')::numeric
        = (SELECT COALESCE(sum(amount), 0) FROM public.v_landlord_payout_settlement WHERE state = 'historical_review'),
    'sources', (SELECT jsonb_object_agg(k, n) FROM (SELECT (s->>'category_key') || ':' || (s->>'product_key') || ':' || (s->>'basis') k, count(*) n FROM src GROUP BY 1) x),
    'error', v_err)
    INTO v_json;
  r := r || v_json;

  RAISE EXCEPTION 'landlord_payables_weekly_float verification (rolled back): %', r;
END
$test$;

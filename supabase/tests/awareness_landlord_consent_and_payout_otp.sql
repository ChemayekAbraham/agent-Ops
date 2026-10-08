-- Landlord awareness calls: consent + payment code (OTP) instead of the merchant-code question. One DO block that ends in an exception, so
-- NOTHING is kept; the report is the exception message. It records controlled calls through record_awareness_call (as the ops test account) and
-- checks (1) the new rules, with tenant and agent calls unchanged, (2) the legacy landlord rows still stand, (3) every report against independent
-- counts written straight against the table, (4) the new answer filters.
DO $$
DECLARE
  ops uuid := 'b9078b67-dc4c-473a-bc88-9510d4bcd0dc';
  rr uuid; out text := ''; r jsonb; s jsonb; t jsonb; c jsonb; lg jsonb; my jsonb; mylg jsonb; n int; exp int; msg text;
  w_from timestamptz := now() - interval '3 days'; w_to timestamptz := now();
  base int; ind_ta int; ind_ll int; ind_cons int; ind_unsure int; ind_refuse int; ind_otp_k int; ind_codes_k int; ind_codes_all int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ops::text, true);
  SELECT id INTO rr FROM rent_requests ORDER BY created_at DESC LIMIT 1;

  -- 1. the rules
  r := public.record_awareness_call(rr, 'landlord', '0700111001', now() - interval '50 minutes', 'answered', NULL, 'did_not_know', NULL, 'yes', 'll consents', 'consents', 'knew');
  out := out || format(E'\nLANDLORD answered stored: consent=%s otp=%s codes=%s 30m=%s explained=%s already=%s  [expect consents / knew / <NULL> / did_not_know / yes / false]',
    r->>'landlord_consent', r->>'aware_payout_otp', coalesce(r->>'aware_merchant_codes','<NULL>'), r->>'aware_30m', r->>'explained', r->>'already_recorded');
  r := public.record_awareness_call(rr, 'landlord', '0700111002', now() - interval '49 minutes', 'answered', NULL, 'knew', NULL, 'partly', 'll unsure', 'unsure', 'heard');
  r := public.record_awareness_call(rr, 'landlord', '0700111003', now() - interval '48 minutes', 'answered', NULL, 'heard', NULL, 'no', 'll refuses', 'refuses', 'did_not_know');
  r := public.record_awareness_call(rr, 'landlord', '0700111004', now() - interval '47 minutes', 'no_answer');
  r := public.record_awareness_call(rr, 'tenant', '0700222001', now() - interval '46 minutes', 'answered', NULL, 'knew', 'heard', 'yes', 'tenant ok');
  r := public.record_awareness_call(rr, 'agent',  '0700333001', now() - interval '45 minutes', 'answered', NULL, 'heard', 'knew', 'partly', 'agent ok');
  out := out || format(E'\nTENANT answered stored: codes=%s consent=%s otp=%s  [expect heard / <NULL> / <NULL>]',
    (SELECT aware_merchant_codes FROM rent_pipeline_awareness_calls WHERE subject_phone='0700222001' AND note='tenant ok'),
    coalesce((SELECT landlord_consent FROM rent_pipeline_awareness_calls WHERE subject_phone='0700222001' AND note='tenant ok'),'<NULL>'),
    coalesce((SELECT aware_payout_otp FROM rent_pipeline_awareness_calls WHERE subject_phone='0700222001' AND note='tenant ok'),'<NULL>'));
  -- a repeat of the same landlord call returns the stored row
  r := public.record_awareness_call(rr, 'landlord', '0700111001', now() - interval '50 minutes', 'answered', NULL, 'did_not_know', NULL, 'yes', 'll consents', 'consents', 'knew');
  out := out || format(E'\nREPEAT of the landlord call: already_recorded=%s  [expect true]', r->>'already_recorded');

  FOREACH msg IN ARRAY ARRAY[
    'landlord_with_codes', 'landlord_missing_consent', 'landlord_missing_otp', 'landlord_bad_consent', 'landlord_bad_otp',
    'tenant_with_consent', 'agent_with_otp', 'tenant_missing_codes', 'unanswered_with_consent', 'unanswered_with_otp'] LOOP
    BEGIN
      IF msg = 'landlord_with_codes' THEN PERFORM public.record_awareness_call(rr, 'landlord', '0700111010', now() - interval '40 minutes', 'answered', NULL, 'knew', 'knew', 'yes', NULL, 'consents', 'knew');
      ELSIF msg = 'landlord_missing_consent' THEN PERFORM public.record_awareness_call(rr, 'landlord', '0700111011', now() - interval '40 minutes', 'answered', NULL, 'knew', NULL, 'yes', NULL, NULL, 'knew');
      ELSIF msg = 'landlord_missing_otp' THEN PERFORM public.record_awareness_call(rr, 'landlord', '0700111012', now() - interval '40 minutes', 'answered', NULL, 'knew', NULL, 'yes', NULL, 'consents', NULL);
      ELSIF msg = 'landlord_bad_consent' THEN PERFORM public.record_awareness_call(rr, 'landlord', '0700111013', now() - interval '40 minutes', 'answered', NULL, 'knew', NULL, 'yes', NULL, 'maybe', 'knew');
      ELSIF msg = 'landlord_bad_otp' THEN PERFORM public.record_awareness_call(rr, 'landlord', '0700111014', now() - interval '40 minutes', 'answered', NULL, 'knew', NULL, 'yes', NULL, 'consents', 'sure');
      ELSIF msg = 'tenant_with_consent' THEN PERFORM public.record_awareness_call(rr, 'tenant', '0700222010', now() - interval '40 minutes', 'answered', NULL, 'knew', 'knew', 'yes', NULL, 'consents', NULL);
      ELSIF msg = 'agent_with_otp' THEN PERFORM public.record_awareness_call(rr, 'agent', '0700333010', now() - interval '40 minutes', 'answered', NULL, 'knew', 'knew', 'yes', NULL, NULL, 'knew');
      ELSIF msg = 'tenant_missing_codes' THEN PERFORM public.record_awareness_call(rr, 'tenant', '0700222011', now() - interval '40 minutes', 'answered', NULL, 'knew', NULL, 'yes');
      ELSIF msg = 'unanswered_with_consent' THEN PERFORM public.record_awareness_call(rr, 'landlord', '0700111015', now() - interval '40 minutes', 'no_answer', NULL, NULL, NULL, NULL, NULL, 'consents', NULL);
      ELSE PERFORM public.record_awareness_call(rr, 'landlord', '0700111016', now() - interval '40 minutes', 'phone_off', NULL, NULL, NULL, NULL, NULL, NULL, 'knew');
      END IF;
      out := out || format(E'\n  %s: NOT refused (unexpected)', msg);
    EXCEPTION WHEN OTHERS THEN out := out || format(E'\n  %s refused: %s', msg, SQLERRM);
    END;
  END LOOP;

  -- the table's own rule: an old-shape landlord row after the cutoff and a mixed row are refused even when the function is bypassed
  BEGIN
    INSERT INTO rent_pipeline_awareness_calls (rent_request_id, subject_type, subject_phone, caller_id, caller_team, pipeline_stage, dial_started_at, recorded_at, call_result, aware_30m, aware_merchant_codes, explained)
    VALUES (rr, 'landlord', '0700111020', ops, 'tenant_ops', 'x', now(), '2026-10-09 10:00+00', 'answered', 'knew', 'knew', 'yes');
    out := out || E'\nOLD-SHAPE landlord row after the cutoff: NOT refused (unexpected)';
  EXCEPTION WHEN check_violation THEN out := out || E'\nOLD-SHAPE landlord row after the cutoff refused by the table (check_violation)'; END;
  BEGIN
    INSERT INTO rent_pipeline_awareness_calls (rent_request_id, subject_type, subject_phone, caller_id, caller_team, pipeline_stage, dial_started_at, call_result, aware_30m, aware_merchant_codes, explained, landlord_consent, aware_payout_otp)
    VALUES (rr, 'tenant', '0700222020', ops, 'tenant_ops', 'x', now(), 'answered', 'knew', 'knew', 'yes', 'consents', 'knew');
    out := out || E'\nTENANT row with landlord answers: NOT refused (unexpected)';
  EXCEPTION WHEN check_violation THEN out := out || E'\nTENANT row with landlord answers refused by the table (check_violation)'; END;
  SELECT count(*) INTO n FROM rent_pipeline_awareness_calls WHERE subject_type='landlord' AND call_result='answered' AND aware_merchant_codes IS NOT NULL;
  out := out || format(E'\nLEGACY landlord rows still on the table (old three questions): %s  (they were recorded before the cutoff)', n);
  out := out || format(E'\nCONSTRAINT validated: %s', (SELECT convalidated FROM pg_constraint WHERE conname='rent_pipeline_awareness_calls_answers_check'));

  -- 2. reports against independent counts (all calls in the last three days, any caller)
  SELECT count(*) FILTER (WHERE call_result='answered' AND subject_type<>'landlord'),
         count(*) FILTER (WHERE call_result='answered' AND subject_type='landlord' AND landlord_consent IS NOT NULL),
         count(*) FILTER (WHERE landlord_consent='consents'), count(*) FILTER (WHERE landlord_consent='unsure'), count(*) FILTER (WHERE landlord_consent='refuses'),
         count(*) FILTER (WHERE aware_payout_otp='knew'),
         count(*) FILTER (WHERE aware_merchant_codes='knew' AND subject_type<>'landlord'),
         count(*) FILTER (WHERE aware_merchant_codes='knew')
    INTO ind_ta, ind_ll, ind_cons, ind_unsure, ind_refuse, ind_otp_k, ind_codes_k, ind_codes_all
  FROM rent_pipeline_awareness_calls WHERE dial_started_at >= date_trunc('day', w_from AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala';
  s := public.awareness_calls_summary(w_from, w_to);
  out := out || format(E'\nSUMMARY answered tenant/agent=%s (indep %s) | answered landlord (new questions)=%s (indep %s) | old-question landlord=%s',
    s->'totals'->>'answered_tenant_agent', ind_ta, s->'totals'->>'answered_landlord', ind_ll, s->'totals'->>'answered_landlord_old_questions');
  out := out || format(E'\nSUMMARY consent consents/unsure/refuses=%s/%s/%s (indep %s/%s/%s) pct consents=%s | otp knew=%s (indep %s) | merchant codes knew=%s (indep over tenant/agent %s; all rows incl. legacy %s)',
    s->'landlord_consent'->>'consents', s->'landlord_consent'->>'unsure', s->'landlord_consent'->>'refuses', ind_cons, ind_unsure, ind_refuse, s->'landlord_consent'->>'consents_pct',
    s->'aware_payout_otp'->>'knew', ind_otp_k, s->'aware_merchant_codes'->>'knew', ind_codes_k, ind_codes_all);
  t := public.awareness_calls_by_team(w_from, w_to);
  out := out || format(E'\nBY TEAM consent sums consents=%s unsure=%s refuses=%s | otp knew=%s | codes knew=%s  [equal the summary]',
    (SELECT sum((e->'landlord_consent'->>'consents')::int) FROM jsonb_array_elements(t->'rows') e),
    (SELECT sum((e->'landlord_consent'->>'unsure')::int) FROM jsonb_array_elements(t->'rows') e),
    (SELECT sum((e->'landlord_consent'->>'refuses')::int) FROM jsonb_array_elements(t->'rows') e),
    (SELECT sum((e->'aware_payout_otp'->>'knew')::int) FROM jsonb_array_elements(t->'rows') e),
    (SELECT sum((e->'aware_merchant_codes'->>'knew')::int) FROM jsonb_array_elements(t->'rows') e));
  c := public.awareness_calls_by_caller(w_from, w_to);
  out := out || format(E'\nBY CALLER consent sums consents=%s unsure=%s refuses=%s | otp knew=%s | codes knew=%s  [equal the summary]',
    (SELECT sum((e->'landlord_consent'->>'consents')::int) FROM jsonb_array_elements(c->'rows') e),
    (SELECT sum((e->'landlord_consent'->>'unsure')::int) FROM jsonb_array_elements(c->'rows') e),
    (SELECT sum((e->'landlord_consent'->>'refuses')::int) FROM jsonb_array_elements(c->'rows') e),
    (SELECT sum((e->'aware_payout_otp'->>'knew')::int) FROM jsonb_array_elements(c->'rows') e),
    (SELECT sum((e->'aware_merchant_codes'->>'knew')::int) FROM jsonb_array_elements(c->'rows') e));
  lg := public.awareness_calls_log(w_from, w_to, NULL, NULL, 'landlord', NULL, 50, 0);
  out := out || format(E'\nLOG landlord rows: total=%s | with consent=%s | with merchant codes (legacy)=%s | first row has both new fields: %s',
    lg->>'total', (SELECT count(*) FROM jsonb_array_elements(lg->'rows') e WHERE e->>'landlord_consent' IS NOT NULL),
    (SELECT count(*) FROM jsonb_array_elements(lg->'rows') e WHERE e->>'aware_merchant_codes' IS NOT NULL),
    (lg->'rows'->0->'landlord_consent') IS NOT NULL AND (lg->'rows'->0->'aware_payout_otp') IS NOT NULL);

  -- 3. the answer filters
  FOREACH msg IN ARRAY ARRAY['consents', 'unsure', 'refuses'] LOOP
    out := out || format(E'\nFILTER landlord_consent=%s: log total=%s summary calls=%s (indep %s)', msg,
      public.awareness_calls_log(w_from, w_to, NULL, NULL, NULL, NULL, 50, 0, NULL, NULL, 'landlord_consent', msg)->>'total',
      public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, NULL, NULL, 'landlord_consent', msg)->'totals'->>'calls',
      (SELECT count(*) FROM rent_pipeline_awareness_calls WHERE landlord_consent = msg AND dial_started_at >= date_trunc('day', w_from AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala'));
  END LOOP;
  out := out || format(E'\nFILTER aware_payout_otp=knew: log total=%s (indep %s)',
    public.awareness_calls_log(w_from, w_to, NULL, NULL, NULL, NULL, 50, 0, NULL, NULL, 'aware_payout_otp', 'knew')->>'total', ind_otp_k);
  out := out || format(E'\nFILTER aware_merchant_codes=knew: log total=%s  [expect %s: tenant/agent only, the legacy landlord rows are not counted]',
    public.awareness_calls_log(w_from, w_to, NULL, NULL, NULL, NULL, 50, 0, NULL, NULL, 'aware_merchant_codes', 'knew')->>'total', ind_codes_k);
  BEGIN PERFORM public.awareness_calls_log(w_from, w_to, NULL, NULL, NULL, NULL, 50, 0, NULL, NULL, 'landlord_consent', 'knew'); out := out || E'\nBAD consent value: NOT refused (unexpected)';
  EXCEPTION WHEN OTHERS THEN out := out || format(E'\nBAD consent value refused: %s', SQLERRM); END;
  BEGIN PERFORM public.awareness_calls_log(w_from, w_to, NULL, NULL, NULL, NULL, 50, 0, NULL, NULL, 'aware_payout_otp', 'consents'); out := out || E'\nBAD otp value: NOT refused (unexpected)';
  EXCEPTION WHEN OTHERS THEN out := out || format(E'\nBAD otp value refused: %s', SQLERRM); END;

  -- 4. my calls
  my := public.my_awareness_calls_summary(w_from, w_to);
  SELECT count(*) FILTER (WHERE landlord_consent='consents'), count(*) FILTER (WHERE aware_payout_otp='knew'), count(*) FILTER (WHERE aware_merchant_codes='knew' AND subject_type<>'landlord')
    INTO ind_cons, ind_otp_k, ind_codes_k FROM rent_pipeline_awareness_calls WHERE caller_id = ops AND dial_started_at >= date_trunc('day', w_from AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala';
  out := out || format(E'\nMY SUMMARY consents=%s (indep %s) otp knew=%s (indep %s) codes knew=%s (indep %s) answered landlord=%s tenant/agent=%s',
    my->'landlord_consent'->>'consents', ind_cons, my->'aware_payout_otp'->>'knew', ind_otp_k, my->'aware_merchant_codes'->>'knew', ind_codes_k,
    my->'totals'->>'answered_landlord', my->'totals'->>'answered_tenant_agent');
  mylg := public.my_awareness_calls_log(w_from, w_to, 50, 0);
  out := out || format(E'\nMY LOG rows=%s with consent=%s', mylg->>'total', (SELECT count(*) FROM jsonb_array_elements(mylg->'rows') e WHERE e->>'landlord_consent' IS NOT NULL));

  -- 5. the plan's own history
  out := out || format(E'\nPER-PLAN history for the plan: %s calls, %s with a consent answer',
    public.get_awareness_calls_for_request(rr)->>'total',
    (SELECT count(*) FROM jsonb_array_elements(public.get_awareness_calls_for_request(rr)->'rows') e WHERE e->>'landlord_consent' IS NOT NULL));

  RAISE EXCEPTION E'awareness_landlord_consent_and_payout_otp report (rolled back, nothing kept):%', out;
END $$;

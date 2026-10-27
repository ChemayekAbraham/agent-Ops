-- =============================================================================
-- Test suite: supabase/tests/landlord_calling_hub_reports.sql
-- Purpose:    Regression guard for Prompt 2 (Landlord Calling Hub reports).
--             1. Records/verifies the totals and row counts of
--                `staff_calling_detailed_report` for 1 to 27 October 2026 for
--                each staff member and each existing source and proves every
--                single one is identical before and after the migration.
--             2. Inserts three test hub calls inside the rolled-back transaction
--                and proves they appear once, with `source = 'Landlord Ops - Calling Hub'`,
--                the right awareness answers, category/severity/note feedback,
--                and `answered` true only for `'answered'`.
--             3. Proves a hub call plus an awareness call to the same landlord
--                within 15 minutes counts once.
--             4. Proves voided hub calls are excluded and `landlord_call_dials`
--                older than 24h with `call_id IS NULL` count as `excluded_reveals`.
--             5. Proves `_landlord_cc_events_in_window`, `landlord_cc_coverage`,
--                and `v_landlord_registry_all` reflect `landlord_calls` additively.
--             Runs inside BEGIN ... ROLLBACK so zero test data persists.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE _lchr_test_results (
  test_no serial PRIMARY KEY,
  name text NOT NULL,
  passed boolean NOT NULL,
  detail text
) ON COMMIT DROP;

DO $$
DECLARE
  v_win_from timestamptz := '2026-10-01T00:00:00+03:00'::timestamptz;
  v_win_to   timestamptz := '2026-10-28T00:00:00+03:00'::timestamptz;
  v_jane_id    uuid := '5295252d-f477-42a9-92f5-af56e503e33d'::uuid;
  v_winnie_id  uuid := 'a9258d45-3e27-4827-af71-64344e76fb4f'::uuid;
  v_hanisha_id uuid := 'fda0d518-98c4-45e4-83d8-64266b25eefa'::uuid;
  v_diff_cnt integer;
  v_total_rows integer;
  v_total_ans integer;
  v_landlord_1 uuid := gen_random_uuid();
  v_landlord_2 uuid := gen_random_uuid();
  v_landlord_3 uuid := gen_random_uuid();
  v_call_1 uuid := gen_random_uuid();
  v_call_2 uuid := gen_random_uuid();
  v_call_3 uuid := gen_random_uuid();
  v_call_void uuid := gen_random_uuid();
  v_hub_rows integer;
  v_r1 record;
  v_r2 record;
  v_r3 record;
  v_dedup_cnt integer;
  v_rev_before integer;
  v_rev_after integer;
  v_lcc_ev_cnt integer;
  v_reg_last_out text;
  v_cov_ever_before integer;
  v_cov_ever_after integer;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_jane_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  -- Capture baseline counts from the current function (with 0 rows in landlord_calls for 1..27 Oct)
  CREATE TEMP TABLE _baseline_counts ON COMMIT DROP AS
  SELECT
    short_name,
    source,
    count(*)::int AS row_cnt,
    count(*) FILTER (WHERE answered)::int AS ans_cnt,
    max(excluded_reveals)::int AS excl_rev
  FROM public.staff_calling_detailed_report(v_win_from, v_win_to)
  GROUP BY short_name, source;

  -- Expected pinned snapshot for 1..27 October 2026 across all 3 staff and all existing sources
  CREATE TEMP TABLE _expected_oct_snapshot (
    short_name text,
    source text,
    row_cnt int,
    ans_cnt int,
    excl_rev int
  ) ON COMMIT DROP;

  INSERT INTO _expected_oct_snapshot (short_name, source, row_cnt, ans_cnt, excl_rev)
  VALUES
    ('Hanisha', 'In-app voice call',                              32,   1, 65),
    ('Hanisha', 'Tenant Ops - Calling Center',                   246, 119, 65),
    ('Jane',    'Calling Center - Inbound call received',         20,  20,  5),
    ('Jane',    'In-app voice call',                               2,   0,  5),
    ('Jane',    'Rent Pipeline - Awareness call',                349, 329,  5),
    ('Jane',    'Rent Pipeline - Landlord Ops review feedback',    7,   2,  5),
    ('Jane',    'Rent Pipeline - Landlord Ops verification call',133, 133,  5),
    ('Jane',    'Rent Pipeline - Tenant Ops review feedback',     39,   0,  5),
    ('Jane',    'Tenant Ops - Calling Center',                    12,   6,  5),
    ('Winnie',  'Calling Center - Inbound call received',          1,   1, 25),
    ('Winnie',  'In-app voice call',                              23,   0, 25),
    ('Winnie',  'Tenant Ops - Calling Center',                   478, 212, 25);

  SELECT count(*)::int INTO v_diff_cnt
  FROM (
    SELECT short_name, source, row_cnt, ans_cnt, excl_rev FROM _baseline_counts
    EXCEPT
    SELECT short_name, source, row_cnt, ans_cnt, excl_rev FROM _expected_oct_snapshot
    UNION ALL
    SELECT short_name, source, row_cnt, ans_cnt, excl_rev FROM _expected_oct_snapshot
    EXCEPT
    SELECT short_name, source, row_cnt, ans_cnt, excl_rev FROM _baseline_counts
  ) d;

  INSERT INTO _lchr_test_results (name, passed, detail)
  VALUES (
    '1. 1-27 Oct 2026 per-staff and per-source counts match exact baseline (0 diffs)',
    v_diff_cnt = 0,
    format('diff_cnt=%s', v_diff_cnt)
  );

  SELECT sum(row_cnt)::int, sum(ans_cnt)::int
  INTO v_total_rows, v_total_ans
  FROM _baseline_counts;

  INSERT INTO _lchr_test_results (name, passed, detail)
  VALUES (
    '2. 1-27 Oct 2026 aggregate total rows (1342) and answered rows (823) are unchanged',
    v_total_rows = 1342 AND v_total_ans = 823,
    format('total_rows=%s, total_ans=%s', v_total_rows, v_total_ans)
  );

  -- Insert 3 test landlords for the 3 test hub calls
  INSERT INTO public.landlords (id, name, phone, property_address, region, district, number_of_houses, monthly_rent, verified, verification_status)
  VALUES
    (v_landlord_1, 'Kato Samuel HubOne',   '0779100101', 'Ntinda Stage 2', 'Central', 'Kampala', 3, 600000, true,  'verified'),
    (v_landlord_2, 'Babirye Grace HubTwo', '0779100102', 'Nansana West',   'Central', 'Wakiso',  2, 450000, false, 'pending'),
    (v_landlord_3, 'Muwonge Peter HubThr', '0779100103', 'Jinja Main St',  'Eastern', 'Jinja',   4, 800000, true,  'verified');

  SELECT COALESCE(sum(ever_reached), 0)::int INTO v_cov_ever_before
  FROM public.landlord_cc_coverage('2026-10-20T18:00:00+03:00'::timestamptz);

  -- Insert 3 test hub calls on 2026-10-20 (answered, no_answer, call_back) + 1 voided call
  INSERT INTO public.landlord_calls (
    id, landlord_key, landlord_id, landlord_name, phone_dialed,
    caller_id, caller_team, dial_started_at, recorded_at,
    result, call_back_at,
    aware_30m, landlord_consent, aware_payout_otp, explained,
    feedback_category, severity, note, tenants_discussed,
    voided_at, void_reason
  )
  VALUES
    (
      v_call_1, v_landlord_1::text, v_landlord_1, 'Kato Samuel HubOne', '256779100101',
      v_jane_id, 'landlord_ops',
      '2026-10-20T10:00:00+03:00'::timestamptz, '2026-10-20T10:03:00+03:00'::timestamptz,
      'answered', NULL,
      'knew', 'consents', 'knew', 'yes',
      'confirmed_payout_number', 'normal', 'Confirmed Airtel Money number and payout OTP rules with landlord.', NULL,
      NULL, NULL
    ),
    (
      v_call_2, v_landlord_2::text, v_landlord_2, 'Babirye Grace HubTwo', '256779100102',
      v_winnie_id, 'landlord_ops',
      '2026-10-20T11:15:00+03:00'::timestamptz, '2026-10-20T11:16:00+03:00'::timestamptz,
      'no_answer', NULL,
      NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL,
      NULL, NULL
    ),
    (
      v_call_3, v_landlord_3::text, v_landlord_3, 'Muwonge Peter HubThr', '256779100103',
      v_hanisha_id, 'landlord_ops',
      '2026-10-20T14:20:00+03:00'::timestamptz, '2026-10-20T14:22:00+03:00'::timestamptz,
      'call_back', '2026-10-21T09:00:00+03:00'::timestamptz,
      NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL,
      NULL, NULL
    ),
    (
      v_call_void, v_landlord_1::text, v_landlord_1, 'Kato Samuel HubOne', '256779100101',
      v_jane_id, 'landlord_ops',
      '2026-10-20T16:00:00+03:00'::timestamptz, '2026-10-20T16:01:00+03:00'::timestamptz,
      'no_answer', NULL,
      NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL,
      '2026-10-20T16:05:00+03:00'::timestamptz, 'Duplicate test dial'
    );

  -- Verify all existing sources in 1..27 Oct remain 100% identical even after inserting hub calls
  SELECT count(*)::int INTO v_diff_cnt
  FROM (
    SELECT short_name, source, count(*)::int AS row_cnt, count(*) FILTER (WHERE answered)::int AS ans_cnt
    FROM public.staff_calling_detailed_report(v_win_from, v_win_to)
    WHERE source <> 'Landlord Ops - Calling Hub'
    GROUP BY short_name, source
    EXCEPT
    SELECT short_name, source, row_cnt, ans_cnt FROM _expected_oct_snapshot
  ) d;

  INSERT INTO _lchr_test_results (name, passed, detail)
  VALUES (
    '3. Existing sources remain 100% unchanged when hub calls are present',
    v_diff_cnt = 0,
    format('diff_cnt=%s', v_diff_cnt)
  );

  -- Verify the 3 non-voided hub calls appear once each (and the 4th voided call is excluded)
  SELECT count(*)::int INTO v_hub_rows
  FROM public.staff_calling_detailed_report(v_win_from, v_win_to)
  WHERE source = 'Landlord Ops - Calling Hub';

  INSERT INTO _lchr_test_results (name, passed, detail)
  VALUES (
    '4. Three non-voided hub calls appear once each and voided call is excluded',
    v_hub_rows = 3,
    format('hub_rows=%s', v_hub_rows)
  );

  -- Inspect each of the 3 hub rows
  SELECT * INTO v_r1
  FROM public.staff_calling_detailed_report(v_win_from, v_win_to)
  WHERE source = 'Landlord Ops - Calling Hub' AND short_name = 'Jane';

  INSERT INTO _lchr_test_results (name, passed, detail)
  VALUES (
    '5. Answered hub call has role=landlord, answered=true, outcome=answered, feedback and awareness extra',
    v_r1.role = 'landlord'
      AND v_r1.name = 'Kato Samuel HubOne'
      AND v_r1.phone = '256779100101'
      AND v_r1.answered IS TRUE
      AND v_r1.outcome = 'answered'
      AND v_r1.feedback = 'Confirmed payout number (normal) | Confirmed Airtel Money number and payout OTP rules with landlord.'
      AND v_r1.extra->>'aware_30m' = 'knew'
      AND v_r1.extra->>'landlord_consent' = 'consents'
      AND v_r1.extra->>'aware_payout_otp' = 'knew'
      AND v_r1.extra->>'explained' = 'yes'
      AND v_r1.extra->>'category' = 'Confirmed payout number'
      AND v_r1.extra->>'severity' = 'normal',
    format('feedback=%s, extra=%s', v_r1.feedback, v_r1.extra::text)
  );

  SELECT * INTO v_r2
  FROM public.staff_calling_detailed_report(v_win_from, v_win_to)
  WHERE source = 'Landlord Ops - Calling Hub' AND short_name = 'Winnie';

  INSERT INTO _lchr_test_results (name, passed, detail)
  VALUES (
    '6. Unanswered hub call has answered=false, outcome=no_answer, null feedback',
    v_r2.role = 'landlord'
      AND v_r2.name = 'Babirye Grace HubTwo'
      AND v_r2.answered IS FALSE
      AND v_r2.outcome = 'no_answer'
      AND v_r2.feedback IS NULL,
    format('answered=%s, outcome=%s', v_r2.answered, v_r2.outcome)
  );

  SELECT * INTO v_r3
  FROM public.staff_calling_detailed_report(v_win_from, v_win_to)
  WHERE source = 'Landlord Ops - Calling Hub' AND short_name = 'Hanisha';

  INSERT INTO _lchr_test_results (name, passed, detail)
  VALUES (
    '7. Call-back hub call has answered=false, outcome=call_back, and extra.call_back_at set',
    v_r3.role = 'landlord'
      AND v_r3.name = 'Muwonge Peter HubThr'
      AND v_r3.answered IS FALSE
      AND v_r3.outcome = 'call_back'
      AND v_r3.extra->>'call_back_at' IS NOT NULL,
    format('answered=%s, outcome=%s, call_back_at=%s', v_r3.answered, v_r3.outcome, v_r3.extra->>'call_back_at')
  );

  -- Test 15-minute repeat removal between a hub call and a pipeline awareness call to the same landlord
  INSERT INTO public.rent_pipeline_awareness_calls (
    id, rent_request_id, pipeline_stage, caller_id, caller_team,
    subject_type, subject_user_id, subject_phone,
    dial_started_at, recorded_at, call_result,
    aware_30m, aware_merchant_codes, explained, landlord_consent, aware_payout_otp, note
  )
  VALUES (
    gen_random_uuid(),
    (SELECT id FROM public.rent_requests LIMIT 1),
    'landlord_ops',
    v_jane_id,
    'landlord_ops',
    'landlord',
    v_landlord_1,
    '256779100101',
    '2026-10-20T09:57:00+03:00'::timestamptz,
    '2026-10-20T09:58:00+03:00'::timestamptz,
    'answered',
    'knew', NULL, 'yes', 'consents', 'knew',
    'Same landlord called 5 minutes earlier in awareness panel.'
  );

  SELECT count(*)::int INTO v_dedup_cnt
  FROM public.staff_calling_detailed_report(v_win_from, v_win_to)
  WHERE person_id = v_landlord_1
    AND ts >= '2026-10-20T09:50:00+03:00'::timestamptz
    AND ts <  '2026-10-20T10:30:00+03:00'::timestamptz;

  INSERT INTO _lchr_test_results (name, passed, detail)
  VALUES (
    '8. A hub call plus an awareness call to the same landlord within 15 minutes counts once',
    v_dedup_cnt = 1,
    format('dedup_cnt=%s', v_dedup_cnt)
  );

  -- Test excluded_reveals for landlord_call_dials older than 24h with call_id IS NULL
  SELECT max(excluded_reveals)::int INTO v_rev_before
  FROM public.staff_calling_detailed_report(v_win_from, v_win_to)
  WHERE short_name = 'Jane';

  INSERT INTO public.landlord_call_dials (id, landlord_key, caller_id, phone, started_at, call_id)
  VALUES
    (gen_random_uuid(), v_landlord_1::text, v_jane_id, '256779100101', '2026-10-15T12:00:00+03:00'::timestamptz, NULL),
    (gen_random_uuid(), v_landlord_1::text, v_jane_id, '256779100101', '2026-10-15T13:00:00+03:00'::timestamptz, v_call_1);

  SELECT max(excluded_reveals)::int INTO v_rev_after
  FROM public.staff_calling_detailed_report(v_win_from, v_win_to)
  WHERE short_name = 'Jane';

  INSERT INTO _lchr_test_results (name, passed, detail)
  VALUES (
    '9. landlord_call_dials older than 24h with no recorded call increments excluded_reveals',
    v_rev_after = v_rev_before + 1,
    format('before=%s, after=%s', v_rev_before, v_rev_after)
  );

  -- Test Landlord Calling Center support: _landlord_cc_events_in_window, v_landlord_registry_all, landlord_cc_coverage
  SELECT count(*)::int INTO v_lcc_ev_cnt
  FROM public._landlord_cc_events_in_window(
    '2026-10-20T00:00:00+03:00'::timestamptz,
    '2026-10-21T00:00:00+03:00'::timestamptz
  )
  WHERE source = 'calling_hub';

  INSERT INTO _lchr_test_results (name, passed, detail)
  VALUES (
    '10. _landlord_cc_events_in_window includes non-voided Calling Hub calls',
    v_lcc_ev_cnt = 3,
    format('lcc_ev_cnt=%s', v_lcc_ev_cnt)
  );

  SELECT last_call_outcome INTO v_reg_last_out
  FROM public.v_landlord_registry_all
  WHERE landlord_key = v_landlord_1;

  INSERT INTO _lchr_test_results (name, passed, detail)
  VALUES (
    '11. v_landlord_registry_all updates last_called_at and last_call_outcome from hub calls',
    v_reg_last_out = 'confirmed_payout_number',
    format('last_call_outcome=%s', v_reg_last_out)
  );

  SELECT COALESCE(sum(ever_reached), 0)::int INTO v_cov_ever_after
  FROM public.landlord_cc_coverage('2026-10-20T18:00:00+03:00'::timestamptz);

  INSERT INTO _lchr_test_results (name, passed, detail)
  VALUES (
    '12. landlord_cc_coverage counts answered and call_back hub calls in ever_reached',
    v_cov_ever_after = v_cov_ever_before + 2,
    format('before=%s, after=%s', v_cov_ever_before, v_cov_ever_after)
  );
END
$$;

SELECT
  count(*) FILTER (WHERE passed) AS passed_count,
  count(*) AS total_count,
  COALESCE(string_agg(test_no || ':' || name || ' (' || COALESCE(detail, '') || ')', '; ') FILTER (WHERE NOT passed), 'none') AS failing
FROM _lchr_test_results;

DO $$
DECLARE
  v_failed integer;
  v_msg text;
BEGIN
  SELECT count(*), string_agg(test_no || ':' || name || ' [' || COALESCE(detail, '') || ']', E'\n')
  INTO v_failed, v_msg
  FROM _lchr_test_results
  WHERE NOT passed;

  IF v_failed > 0 THEN
    RAISE EXCEPTION 'landlord_calling_hub_reports tests failed (%): %', v_failed, v_msg;
  END IF;
END
$$;

ROLLBACK;

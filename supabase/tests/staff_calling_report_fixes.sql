-- =============================================================================
-- Test suite: supabase/tests/staff_calling_report_fixes.sql
-- Purpose:    Regression guard for Calling & Pipeline Report fixes (Prompt 1):
--               1. `is_test_contact` boolean column exists on `profiles`,
--                  `landlords`, and `landlord_leads` (NOT NULL DEFAULT false).
--               2. Contacts with "Test" in their name are NOT excluded when
--                  `is_test_contact = false`, while contacts with
--                  `is_test_contact = true` ARE excluded and counted in
--                  `excluded_reveals` / `extra->>'excluded_test_contacts'`.
--               3. Cross-source deduplication only merges records across
--                  DIFFERENT logging systems within 3 minutes (180 seconds),
--                  never dropping two calls placed minutes apart in the same
--                  system or > 3 minutes apart across systems.
--               4. Timestamped dials with no saved outcome (`cc_call_attempts`
--                  with `outcome IS NULL` and `landlord_call_dials` with
--                  `call_id IS NULL`) are included with `outcome = 'awaiting_result'`
--                  and `extra->>'awaiting_result' = 'true'`.
--               5. Real-week verification (28 Oct - 3 Nov 2026) for Jane,
--                  Winnie, and Hanisha.
--             Runs inside BEGIN ... ROLLBACK so zero test data persists.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE _scrf_test_results (
  test_no serial PRIMARY KEY,
  name text NOT NULL,
  passed boolean NOT NULL,
  detail text
) ON COMMIT DROP;

DO $$
DECLARE
  v_jane_id    uuid := '5295252d-f477-42a9-92f5-af56e503e33d'::uuid;
  v_winnie_id  uuid := 'a9258d45-3e27-4827-af71-64344e76fb4f'::uuid;
  v_hanisha_id uuid := 'fda0d518-98c4-45e4-83d8-64266b25eefa'::uuid;
  v_col_cnt integer;
  v_ll_real_test_name uuid := gen_random_uuid();
  v_ll_flagged_test   uuid := gen_random_uuid();
  v_ll_dedupe         uuid := gen_random_uuid();
  v_win_from timestamptz := '2026-10-20T00:00:00+03:00'::timestamptz;
  v_win_to   timestamptz := '2026-10-21T00:00:00+03:00'::timestamptz;
  v_real_name_cnt integer;
  v_flagged_cnt integer;
  v_excl_test_cnt integer;
  v_same_source_cnt integer;
  v_diff_source_2m_cnt integer;
  v_diff_source_5m_cnt integer;
  v_awaiting_hub_cnt integer;
  v_real_week_summary jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_jane_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  -- Test 1: Verify `is_test_contact` column on profiles, landlords, landlord_leads
  SELECT count(*)::int INTO v_col_cnt
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('profiles', 'landlords', 'landlord_leads')
    AND column_name = 'is_test_contact'
    AND data_type = 'boolean'
    AND is_nullable = 'NO';

  INSERT INTO _scrf_test_results (name, passed, detail)
  VALUES (
    '1. is_test_contact boolean NOT NULL column exists on profiles, landlords, and landlord_leads',
    v_col_cnt = 3,
    format('col_cnt=%s', v_col_cnt)
  );

  -- Test 2: Name containing "Test" is kept when is_test_contact=false; excluded when is_test_contact=true
  INSERT INTO public.landlords (id, name, phone, property_address, region, district, number_of_houses, monthly_rent, verified, verification_status, is_test_contact)
  VALUES
    (v_ll_real_test_name, 'Byaruhanga Test Guard', '0779200201', 'Kawempe Stage', 'Central', 'Kampala', 2, 500000, true, 'verified', false),
    (v_ll_flagged_test,   'Synthetic QA Contact',  '0779200202', 'Ntinda Stage',  'Central', 'Kampala', 1, 300000, false, 'pending', true);

  INSERT INTO public.landlord_calls (
    id, landlord_key, landlord_id, landlord_name, phone_dialed,
    caller_id, caller_team, dial_started_at, recorded_at, result,
    aware_30m, landlord_consent, aware_payout_otp, explained,
    feedback_category, severity, note
  )
  VALUES
    (
      gen_random_uuid(), v_ll_real_test_name::text, v_ll_real_test_name, 'Byaruhanga Test Guard', '256779200201',
      v_jane_id, 'landlord_ops', '2026-10-20T08:10:00+03:00'::timestamptz, '2026-10-20T08:11:00+03:00'::timestamptz, 'answered',
      'knew', 'consents', 'knew', 'yes',
      'confirmed_payout_number', 'normal', 'Confirmed Airtel Money number and payout OTP rules with landlord.'
    ),
    (
      gen_random_uuid(), v_ll_flagged_test::text, v_ll_flagged_test, 'Synthetic QA Contact', '256779200202',
      v_jane_id, 'landlord_ops', '2026-10-20T08:15:00+03:00'::timestamptz, '2026-10-20T08:16:00+03:00'::timestamptz, 'answered',
      'knew', 'consents', 'knew', 'yes',
      'confirmed_payout_number', 'normal', 'Confirmed Airtel Money number and payout OTP rules with landlord.'
    );

  SELECT count(*)::int INTO v_real_name_cnt
  FROM public.staff_calling_detailed_report(v_win_from, v_win_to)
  WHERE person_id = v_ll_real_test_name;

  SELECT count(*)::int INTO v_flagged_cnt
  FROM public.staff_calling_detailed_report(v_win_from, v_win_to)
  WHERE person_id = v_ll_flagged_test;

  SELECT coalesce(max((extra->>'excluded_test_contacts')::int), 0) INTO v_excl_test_cnt
  FROM public.staff_calling_detailed_report(v_win_from, v_win_to)
  WHERE short_name = 'Jane';

  INSERT INTO _scrf_test_results (name, passed, detail)
  VALUES (
    '2. Contact with "Test" in name is kept when is_test_contact=false, and is_test_contact=true is excluded',
    v_real_name_cnt = 1 AND v_flagged_cnt = 0 AND v_excl_test_cnt >= 1,
    format('real_name_cnt=%s, flagged_cnt=%s, excl_test_cnt=%s', v_real_name_cnt, v_flagged_cnt, v_excl_test_cnt)
  );

  -- Test 3: Two calls placed 2 minutes apart in the SAME logging system are BOTH kept
  INSERT INTO public.landlords (id, name, phone, property_address, region, district, number_of_houses, monthly_rent, verified, verification_status, is_test_contact)
  VALUES
    (v_ll_dedupe, 'Mugisha Paul DedupeCheck', '0779200203', 'Mengo Hill', 'Central', 'Kampala', 3, 600000, true, 'verified', false);

  INSERT INTO public.landlord_calls (
    id, landlord_key, landlord_id, landlord_name, phone_dialed,
    caller_id, caller_team, dial_started_at, recorded_at, result,
    aware_30m, landlord_consent, aware_payout_otp, explained,
    feedback_category, severity, note
  )
  VALUES
    (
      gen_random_uuid(), v_ll_dedupe::text, v_ll_dedupe, 'Mugisha Paul DedupeCheck', '256779200203',
      v_winnie_id, 'landlord_ops', '2026-10-20T09:00:00+03:00'::timestamptz, '2026-10-20T09:00:30+03:00'::timestamptz, 'no_answer',
      NULL, NULL, NULL, NULL,
      NULL, NULL, NULL
    ),
    (
      gen_random_uuid(), v_ll_dedupe::text, v_ll_dedupe, 'Mugisha Paul DedupeCheck', '256779200203',
      v_winnie_id, 'landlord_ops', '2026-10-20T09:02:00+03:00'::timestamptz, '2026-10-20T09:02:30+03:00'::timestamptz, 'answered',
      'knew', 'consents', 'knew', 'yes',
      'confirmed_payout_number', 'normal', 'Second call reached landlord 2 minutes later and confirmed payout number.'
    );

  SELECT count(*)::int INTO v_same_source_cnt
  FROM public.staff_calling_detailed_report(v_win_from, v_win_to)
  WHERE short_name = 'Winnie' AND person_id = v_ll_dedupe;

  INSERT INTO _scrf_test_results (name, passed, detail)
  VALUES (
    '3. Two recorded calls placed 2 minutes apart in the same logging system are both kept',
    v_same_source_cnt = 2,
    format('same_source_cnt=%s', v_same_source_cnt)
  );

  -- Test 4: Cross-source same-person calls within 2 minutes (120s <= 180s) merge to 1, while 5 minutes apart (300s > 180s) stay 2
  INSERT INTO public.rent_pipeline_awareness_calls (
    id, rent_request_id, pipeline_stage, caller_id, caller_team,
    subject_type, subject_user_id, subject_phone,
    dial_started_at, recorded_at, call_result,
    aware_30m, aware_merchant_codes, explained, landlord_consent, aware_payout_otp, note
  )
  VALUES
    (
      gen_random_uuid(), (SELECT id FROM public.rent_requests LIMIT 1), 'landlord_ops',
      v_winnie_id, 'landlord_ops', 'landlord', v_ll_dedupe, '256779200203',
      '2026-10-20T09:03:00+03:00'::timestamptz, '2026-10-20T09:03:30+03:00'::timestamptz, 'answered',
      'knew', NULL, 'yes', 'consents', 'knew', 'Cross-source log 1m after 09:02:30 hub call.'
    ),
    (
      gen_random_uuid(), (SELECT id FROM public.rent_requests LIMIT 1), 'landlord_ops',
      v_winnie_id, 'landlord_ops', 'landlord', v_ll_dedupe, '256779200203',
      '2026-10-20T09:08:00+03:00'::timestamptz, '2026-10-20T09:08:30+03:00'::timestamptz, 'answered',
      'knew', NULL, 'yes', 'consents', 'knew', 'Separate call 6m after 09:02:30 hub call.'
    );

  SELECT
    count(*) FILTER (WHERE ts < '2026-10-20T09:05:00+03:00'::timestamptz)::int,
    count(*)::int
  INTO v_diff_source_2m_cnt, v_diff_source_5m_cnt
  FROM public.staff_calling_detailed_report(v_win_from, v_win_to)
  WHERE short_name = 'Winnie' AND person_id = v_ll_dedupe;

  INSERT INTO _scrf_test_results (name, passed, detail)
  VALUES (
    '4. Cross-source log 1m apart merges into hub call (2 kept before 09:05), while call 6m later is kept (3 total)',
    v_diff_source_2m_cnt = 2 AND v_diff_source_5m_cnt = 3,
    format('before_0905=%s, total=%s', v_diff_source_2m_cnt, v_diff_source_5m_cnt)
  );

  -- Test 5: Unrecorded dial in landlord_call_dials appears as outcome='awaiting_result'
  INSERT INTO public.landlord_call_dials (id, landlord_key, caller_id, phone, started_at, call_id)
  VALUES (
    gen_random_uuid(), v_ll_real_test_name::text, v_hanisha_id, '256779200201', '2026-10-20T15:00:00+03:00'::timestamptz, NULL
  );

  SELECT count(*)::int INTO v_awaiting_hub_cnt
  FROM public.staff_calling_detailed_report(v_win_from, v_win_to)
  WHERE short_name = 'Hanisha'
    AND person_id = v_ll_real_test_name
    AND outcome = 'awaiting_result'
    AND answered IS FALSE
    AND (extra->>'awaiting_result')::boolean IS TRUE;

  INSERT INTO _scrf_test_results (name, passed, detail)
  VALUES (
    '5. Unrecorded timestamped dial in landlord_call_dials appears as outcome=awaiting_result',
    v_awaiting_hub_cnt = 1,
    format('awaiting_hub_cnt=%s', v_awaiting_hub_cnt)
  );

  -- Test 6: Real-week figures (28 Oct - 3 Nov 2026) for Jane, Winnie, and Hanisha
  SELECT jsonb_object_agg(short_name, stats) INTO v_real_week_summary
  FROM (
    SELECT
      short_name,
      jsonb_build_object(
        'total_rows', count(*),
        'calls_made', count(*) FILTER (WHERE outcome <> 'review recorded'),
        'recorded_calls', count(*) FILTER (WHERE outcome NOT IN ('review recorded', 'awaiting_result')),
        'awaiting_result', count(*) FILTER (WHERE outcome = 'awaiting_result'),
        'review_only', count(*) FILTER (WHERE outcome = 'review recorded'),
        'reached_calls', count(*) FILTER (WHERE outcome NOT IN ('review recorded', 'awaiting_result') AND answered IS TRUE),
        'wrong_number', count(*) FILTER (WHERE outcome = 'wrong_number'),
        'phone_off', count(*) FILTER (WHERE outcome = 'phone_off'),
        'excluded_reveals', max(excluded_reveals),
        'excluded_cross_source_dupes', max((extra->>'excluded_cross_source_dupes')::int),
        'excluded_test_contacts', max((extra->>'excluded_test_contacts')::int)
      ) AS stats
    FROM public.staff_calling_detailed_report(
      '2026-10-28T00:00:00+03:00'::timestamptz,
      '2026-11-04T00:00:00+03:00'::timestamptz
    )
    GROUP BY short_name
  ) s;

  INSERT INTO _scrf_test_results (name, passed, detail)
  VALUES (
    '6. Real week (28 Oct - 3 Nov 2026) returns true calls made (recorded + awaiting_result) for all 3 staff',
    (v_real_week_summary->'Hanisha'->>'calls_made')::int = 252
      AND (v_real_week_summary->'Hanisha'->>'recorded_calls')::int = 245
      AND (v_real_week_summary->'Hanisha'->>'awaiting_result')::int = 7
      AND (v_real_week_summary->'Winnie'->>'calls_made')::int = 303
      AND (v_real_week_summary->'Winnie'->>'recorded_calls')::int = 300
      AND (v_real_week_summary->'Winnie'->>'awaiting_result')::int = 3
      AND (v_real_week_summary->'Jane'->>'total_rows')::int = 104
      AND (v_real_week_summary->'Jane'->>'calls_made')::int = 100
      AND (v_real_week_summary->'Jane'->>'recorded_calls')::int = 100
      AND (v_real_week_summary->'Jane'->>'awaiting_result')::int = 0
      AND (v_real_week_summary->'Jane'->>'review_only')::int = 4,
    v_real_week_summary::text
  );
END
$$;

SELECT
  count(*) FILTER (WHERE passed) AS passed_count,
  count(*) AS total_count,
  COALESCE(string_agg(test_no || ':' || name || ' (' || COALESCE(detail, '') || ')', '; ') FILTER (WHERE NOT passed), 'none') AS failing,
  (SELECT detail FROM _scrf_test_results WHERE test_no = 6) AS real_week_after
FROM _scrf_test_results;

DO $$
DECLARE
  v_failed integer;
  v_msg text;
BEGIN
  SELECT count(*), string_agg(test_no || ':' || name || ' [' || COALESCE(detail, '') || ']', E'\n')
  INTO v_failed, v_msg
  FROM _scrf_test_results
  WHERE NOT passed;

  IF v_failed > 0 THEN
    RAISE EXCEPTION 'staff_calling_report_fixes tests failed (%): %', v_failed, v_msg;
  END IF;
END
$$;

ROLLBACK;

-- =============================================================================
-- Tests: supabase/tests/landlord_calling_reports.sql
-- Purpose: Verify the Landlord Calling Center reporting RPCs:
--   1. Totals reconcile across landlord_cc_daily_summary, landlord_cc_weekly_report,
--      landlord_cc_staff_performance, and landlord_cc_landlord_call_log (including
--      voided attempt exclusion, received calls, callbacks, and follow-ups).
--   2. Coverage invariance: landlord_cc_coverage has ever_reached <= registry_total,
--      reached_this_round <= registry_total, reached_this_month <= registry_total,
--      never_called <= registry_total, and sum(registry_total) = count(v_landlord_registry_all).
--   3. Concerns & Round reports: landlord_cc_concerns_report and landlord_cc_round_report
--      reconcile with cycle rows and forwarded concerns.
--   4. Tenant report invariance: cc_weekly_all_calls_report and cc_concern_handling_report
--      outputs and definitions are identical before and after.
-- Every test block runs inside BEGIN ... ROLLBACK so zero data is modified.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- TEST BLOCK 1: Totals reconciliation (daily_summary = weekly_report = staff_performance = call_log)
-- -----------------------------------------------------------------------------
BEGIN;

DO $test1$
DECLARE
  v_admin_id uuid;
  v_caller_b uuid;
  v_landlord_1 uuid;
  v_landlord_2 uuid;
  v_cycle_id uuid := gen_random_uuid();
  v_row_1 uuid := gen_random_uuid();
  v_row_2 uuid := gen_random_uuid();
  v_att_engaged uuid := gen_random_uuid();
  v_att_callback uuid := gen_random_uuid();
  v_att_noans uuid := gen_random_uuid();
  v_att_voided uuid := gen_random_uuid();
  v_recv_id uuid := gen_random_uuid();
  v_cat_id uuid;
  v_week_start date := DATE '2026-10-21'; -- Wednesday
  v_week_end   date := DATE '2026-10-27'; -- Tuesday
  v_daily_total bigint;
  v_daily_made bigint;
  v_daily_recv bigint;
  v_daily_reached bigint;
  v_daily_engaged bigint;
  v_daily_unreach bigint;
  v_daily_cb bigint;
  v_weekly jsonb;
  v_wk_total bigint;
  v_wk_made bigint;
  v_wk_recv bigint;
  v_wk_reached bigint;
  v_wk_engaged bigint;
  v_wk_unreach bigint;
  v_wk_cb bigint;
  v_staff_total bigint;
  v_staff_made bigint;
  v_staff_recv bigint;
  v_staff_reached bigint;
  v_staff_engaged bigint;
  v_staff_unreach bigint;
  v_staff_cb bigint;
  v_staff_fu_owed bigint;
  v_staff_fu_overdue bigint;
  v_log_total bigint;
BEGIN
  -- Pick a super_admin / landlord_ops staff caller for auth context
  SELECT ur.user_id INTO v_admin_id
  FROM public.user_roles ur
  WHERE ur.role IN ('super_admin'::app_role, 'landlord_ops'::app_role, 'operations'::app_role)
    AND COALESCE(ur.enabled, true) = true
  ORDER BY (ur.role = 'super_admin'::app_role) DESC
  LIMIT 1;

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'TEST 1 SETUP FAILED: no eligible staff user found';
  END IF;

  SELECT p.id INTO v_caller_b
  FROM public.profiles p
  WHERE p.id <> v_admin_id
  LIMIT 1;

  -- Authenticate as staff user
  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_id::text, 'role', 'authenticated')::text, true);

  -- Pick two landlords from registry
  SELECT landlord_key INTO v_landlord_1 FROM public.v_landlord_registry_all LIMIT 1;
  SELECT landlord_key INTO v_landlord_2 FROM public.v_landlord_registry_all OFFSET 1 LIMIT 1;

  SELECT id INTO v_cat_id
  FROM public.cc_feedback_categories
  WHERE 'landlord'::cc_subject_type = ANY(applies_to)
    AND code = 'reached_ok'
  LIMIT 1;

  -- Insert synthetic landlord round & cycle rows in the target Wed-Tue week (2026-10-21 .. 2026-10-27)
  INSERT INTO public.cc_call_cycles (
    id, subject_type, cycle_no, title, description, opened_by, opened_at, closed_at
  ) VALUES (
    v_cycle_id, 'landlord'::cc_subject_type, 999901, 'Test Landlord Report Round',
    'landlords_registry_all', v_admin_id,
    TIMESTAMPTZ '2026-10-21 09:00:00+03', TIMESTAMPTZ '2026-10-25 18:00:00+03'
  );

  INSERT INTO public.cc_cycle_rows (
    id, cycle_id, subject_type, subject_id, state, priority_value, assigned_caller_id
  ) VALUES
    (v_row_1, v_cycle_id, 'landlord'::cc_subject_type, v_landlord_1, 'engaged'::cc_row_state, 10, v_admin_id),
    (v_row_2, v_cycle_id, 'landlord'::cc_subject_type, v_landlord_2, 'parked'::cc_row_state, 5, v_caller_b);

  -- Insert 4 call attempts:
  --   1) engaged (valid) on Wed 2026-10-21
  --   2) callback_booked (valid) on Thu 2026-10-22
  --   3) no_answer (valid) on Fri 2026-10-23
  --   4) voided attempt on Fri 2026-10-23 (MUST BE EXCLUDED)
  INSERT INTO public.cc_call_attempts (
    id, cycle_row_id, caller_id, revealed_at, recorded_at, outcome, channel, void_reason, created_at
  ) VALUES (
    v_att_engaged, v_row_1, v_admin_id, TIMESTAMPTZ '2026-10-21 10:00:00+03', TIMESTAMPTZ '2026-10-21 10:02:00+03', 'engaged'::cc_attempt_outcome, 'phone', NULL, TIMESTAMPTZ '2026-10-21 10:02:00+03'
  );
  UPDATE public.cc_cycle_rows SET attempts_made = attempts_made + 1 WHERE id = v_row_1;

  INSERT INTO public.cc_call_attempts (
    id, cycle_row_id, caller_id, revealed_at, recorded_at, outcome, channel, void_reason, created_at
  ) VALUES (
    v_att_callback, v_row_1, v_admin_id, TIMESTAMPTZ '2026-10-22 11:00:00+03', TIMESTAMPTZ '2026-10-22 11:03:00+03', 'callback_booked'::cc_attempt_outcome, 'phone', NULL, TIMESTAMPTZ '2026-10-22 11:03:00+03'
  );
  UPDATE public.cc_cycle_rows SET attempts_made = attempts_made + 1 WHERE id = v_row_1;

  INSERT INTO public.cc_call_attempts (
    id, cycle_row_id, caller_id, revealed_at, recorded_at, outcome, channel, void_reason, created_at
  ) VALUES (
    v_att_noans, v_row_2, v_caller_b, TIMESTAMPTZ '2026-10-23 14:00:00+03', TIMESTAMPTZ '2026-10-23 14:01:00+03', 'no_answer'::cc_attempt_outcome, 'phone', NULL, TIMESTAMPTZ '2026-10-23 14:01:00+03'
  );
  UPDATE public.cc_cycle_rows SET attempts_made = attempts_made + 1 WHERE id = v_row_2;

  INSERT INTO public.cc_call_attempts (
    id, cycle_row_id, caller_id, revealed_at, recorded_at, outcome, channel, void_reason, created_at
  ) VALUES (
    v_att_voided, v_row_2, v_caller_b, TIMESTAMPTZ '2026-10-23 14:05:00+03', TIMESTAMPTZ '2026-10-23 14:06:00+03', 'refused'::cc_attempt_outcome, NULL, 'accidental_click', TIMESTAMPTZ '2026-10-23 14:06:00+03'
  );

  IF v_cat_id IS NOT NULL THEN
    INSERT INTO public.cc_feedback (
      attempt_id, category_id, severity, note, consent_to_contact
    ) VALUES (
      v_att_engaged, v_cat_id, 'normal', 'Confirmed landlord details and active payout phone number', true
    );
  END IF;

  -- Insert 1 inbound received landlord call on Sat 2026-10-24
  INSERT INTO public.cc_received_calls (
    id, caller_phone, caller_name, linked_kind, linked_user_id, concern, notes, status, called_at, recorded_by, recorded_by_name
  ) VALUES (
    v_recv_id, '256772111222', 'Test Inbound Landlord', 'landlord', v_landlord_1,
    'Checking monthly Rent Plan payout schedule', 'Explained payout schedule', 'resolved',
    TIMESTAMPTZ '2026-10-24 12:00:00+03', v_admin_id, 'Admin Caller'
  );

  -- Insert 1 open overdue concern/follow-up for v_admin_id
  INSERT INTO public.cc_forwarded_concerns (
    source_kind, cycle_row_id, subject_type, caller_name,
    title, context, priority, status, forwarded_by, forwarded_by_name,
    forwarded_to, forwarded_to_name, due_at, created_at
  ) VALUES (
    'outbound_call', v_row_1, 'landlord', 'Test Landlord Followup',
    'Call back landlord after work', 'Follow up on Rent Plan details', 'normal', 'sent',
    v_admin_id, 'Admin Caller', v_admin_id, 'Admin Caller',
    now() - interval '2 hours', TIMESTAMPTZ '2026-10-22 11:05:00+03'
  );

  -- 1. Aggregate daily_summary over the Wed-Tue week
  SELECT
    COALESCE(sum(total_calls), 0),
    COALESCE(sum(made_calls), 0),
    COALESCE(sum(received_calls), 0),
    COALESCE(sum(reached_calls), 0),
    COALESCE(sum(engaged_calls), 0),
    COALESCE(sum(unreachable_calls), 0),
    COALESCE(sum(callback_calls), 0)
  INTO
    v_daily_total, v_daily_made, v_daily_recv, v_daily_reached,
    v_daily_engaged, v_daily_unreach, v_daily_cb
  FROM public.landlord_cc_daily_summary(v_week_start, v_week_end);

  -- 2. Read weekly_report for the same Wednesday start
  v_weekly := public.landlord_cc_weekly_report(v_week_start);
  v_wk_total   := (v_weekly->'totals'->>'total_calls')::bigint;
  v_wk_made    := (v_weekly->'totals'->>'made_calls')::bigint;
  v_wk_recv    := (v_weekly->'totals'->>'received_calls')::bigint;
  v_wk_reached := (v_weekly->'totals'->>'reached_calls')::bigint;
  v_wk_engaged := (v_weekly->'totals'->>'engaged_calls')::bigint;
  v_wk_unreach := (v_weekly->'totals'->>'unreachable_calls')::bigint;
  v_wk_cb      := (v_weekly->'totals'->>'callback_calls')::bigint;

  -- 3. Aggregate staff_performance over the same Wed-Tue week
  SELECT
    COALESCE(sum(total_calls), 0),
    COALESCE(sum(reached_calls), 0),
    COALESCE(sum(engaged_calls), 0),
    COALESCE(sum(unreachable_calls), 0),
    COALESCE(sum(callback_calls), 0),
    COALESCE(sum(followups_owed), 0),
    COALESCE(sum(followups_overdue), 0)
  INTO
    v_staff_total, v_staff_reached,
    v_staff_engaged, v_staff_unreach, v_staff_cb,
    v_staff_fu_owed, v_staff_fu_overdue
  FROM public.landlord_cc_staff_performance(v_week_start, v_week_end);

  -- 4. Read landlord_call_log total_count over the same Wed-Tue week
  SELECT COALESCE(max(total_count), 0)
    INTO v_log_total
  FROM public.landlord_cc_landlord_call_log(v_week_start, v_week_end, 10, 0);

  -- Assert non-zero synthetic calls (at least 4 valid calls: 3 made + 1 received; voided excluded)
  IF v_daily_total < 4 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: expected >= 4 calls in window, got %', v_daily_total;
  END IF;

  -- Assert exact reconciliation: daily_summary == weekly_report == staff_performance == call_log
  IF v_daily_total <> v_wk_total OR v_daily_total <> v_staff_total OR v_daily_total <> v_log_total THEN
    RAISE EXCEPTION 'TEST 1 FAILED: total_calls mismatch (daily=%, weekly=%, staff=%, log=%)',
      v_daily_total, v_wk_total, v_staff_total, v_log_total;
  END IF;

  IF v_daily_made <> v_wk_made THEN
    RAISE EXCEPTION 'TEST 1 FAILED: made_calls mismatch (daily=%, weekly=%)',
      v_daily_made, v_wk_made;
  END IF;

  IF v_daily_recv <> v_wk_recv THEN
    RAISE EXCEPTION 'TEST 1 FAILED: received_calls mismatch (daily=%, weekly=%)',
      v_daily_recv, v_wk_recv;
  END IF;

  IF v_daily_reached <> v_wk_reached OR v_daily_reached <> v_staff_reached THEN
    RAISE EXCEPTION 'TEST 1 FAILED: reached_calls mismatch (daily=%, weekly=%, staff=%)',
      v_daily_reached, v_wk_reached, v_staff_reached;
  END IF;

  IF v_daily_engaged <> v_wk_engaged OR v_daily_engaged <> v_staff_engaged THEN
    RAISE EXCEPTION 'TEST 1 FAILED: engaged_calls mismatch (daily=%, weekly=%, staff=%)',
      v_daily_engaged, v_wk_engaged, v_staff_engaged;
  END IF;

  IF v_daily_unreach <> v_wk_unreach OR v_daily_unreach <> v_staff_unreach THEN
    RAISE EXCEPTION 'TEST 1 FAILED: unreachable_calls mismatch (daily=%, weekly=%, staff=%)',
      v_daily_unreach, v_wk_unreach, v_staff_unreach;
  END IF;

  IF v_daily_cb <> v_wk_cb OR v_daily_cb <> v_staff_cb THEN
    RAISE EXCEPTION 'TEST 1 FAILED: callback_calls mismatch (daily=%, weekly=%, staff=%)',
      v_daily_cb, v_wk_cb, v_staff_cb;
  END IF;

  -- Assert voided attempt is NOT present in landlord_call_log
  IF EXISTS (
    SELECT 1
    FROM public.landlord_cc_landlord_call_log(v_week_start, v_week_end, 500, 0)
    WHERE call_id = v_att_voided
  ) THEN
    RAISE EXCEPTION 'TEST 1 FAILED: voided call attempt appeared in landlord_cc_landlord_call_log';
  END IF;

  -- Assert followups owed & overdue are tracked in staff_performance
  IF v_staff_fu_owed < 1 OR v_staff_fu_overdue < 1 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: expected followups_owed >= 1 and followups_overdue >= 1, got owed=%, overdue=%',
      v_staff_fu_owed, v_staff_fu_overdue;
  END IF;

  -- Assert round_report reconciles with cycle rows
  IF (SELECT (public.landlord_cc_round_report(v_cycle_id)->'totals'->>'reached_count')::int) <> 1
     OR (SELECT (public.landlord_cc_round_report(v_cycle_id)->'totals'->>'parked_count')::int) <> 1
     OR (SELECT (public.landlord_cc_round_report(v_cycle_id)->'totals'->>'total_rows')::int) <> 2 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: landlord_cc_round_report totals mismatch: %',
      public.landlord_cc_round_report(v_cycle_id)->'totals';
  END IF;

  RAISE NOTICE 'TEST 1 PASSED: daily_summary (%) == weekly_report (%) == staff_performance (%) == call_log (%), voided excluded, round_report verified',
    v_daily_total, v_wk_total, v_staff_total, v_log_total;
END
$test1$;

ROLLBACK;

-- -----------------------------------------------------------------------------
-- TEST BLOCK 2: Coverage invariants (reached <= registry_total & sum = registry size)
-- -----------------------------------------------------------------------------
BEGIN;

DO $test2$
DECLARE
  v_admin_id uuid;
  v_reg_count bigint;
  v_cov_sum bigint;
  v_bad_rows bigint;
BEGIN
  SELECT ur.user_id INTO v_admin_id
  FROM public.user_roles ur
  WHERE ur.role IN ('super_admin'::app_role, 'landlord_ops'::app_role, 'operations'::app_role)
    AND COALESCE(ur.enabled, true) = true
  ORDER BY (ur.role = 'super_admin'::app_role) DESC
  LIMIT 1;

  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_id::text, 'role', 'authenticated')::text, true);

  SELECT count(*) INTO v_reg_count FROM public.v_landlord_registry_all;

  CREATE TEMP TABLE _cov_snap ON COMMIT DROP AS
  SELECT * FROM public.landlord_cc_coverage(now());

  SELECT COALESCE(sum(registry_total), 0) INTO v_cov_sum FROM _cov_snap;

  IF v_cov_sum <> v_reg_count THEN
    RAISE EXCEPTION 'TEST 2 FAILED: coverage sum(registry_total) (%) <> v_landlord_registry_all count (%)',
      v_cov_sum, v_reg_count;
  END IF;

  SELECT count(*) INTO v_bad_rows
  FROM _cov_snap
  WHERE ever_reached > registry_total
     OR reached_this_round > registry_total
     OR reached_this_month > registry_total
     OR never_called > registry_total
     OR called_but_unreached > registry_total
     OR (ever_reached + called_but_unreached + never_called) <> registry_total
     OR ever_reached < 0
     OR registry_total < 0;

  IF v_bad_rows <> 0 THEN
    RAISE EXCEPTION 'TEST 2 FAILED: % coverage rows violated reached <= registry_total or partition sum = registry_total',
      v_bad_rows;
  END IF;

  RAISE NOTICE 'TEST 2 PASSED: coverage sum(registry_total) = %, 0 invariant violations across % region/district buckets',
    v_cov_sum, (SELECT count(*) FROM _cov_snap);
END
$test2$;

ROLLBACK;

-- -----------------------------------------------------------------------------
-- TEST BLOCK 3: Concerns report & Tenant report invariance
-- -----------------------------------------------------------------------------
BEGIN;

DO $test3$
DECLARE
  v_admin_id uuid;
  v_recv_id uuid := gen_random_uuid();
  v_fc_id uuid := gen_random_uuid();
  v_concerns jsonb;
  v_tenant_all_calls_cnt bigint;
  v_tenant_concerns jsonb;
  v_prosrc_weekly text;
  v_prosrc_concern text;
BEGIN
  SELECT ur.user_id INTO v_admin_id
  FROM public.user_roles ur
  WHERE ur.role IN ('super_admin'::app_role, 'landlord_ops'::app_role, 'operations'::app_role)
    AND COALESCE(ur.enabled, true) = true
  ORDER BY (ur.role = 'super_admin'::app_role) DESC
  LIMIT 1;

  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_id::text, 'role', 'authenticated')::text, true);

  -- Snapshot tenant report outputs BEFORE inserting landlord-only concern
  SELECT count(*) INTO v_tenant_all_calls_cnt
  FROM public.cc_weekly_all_calls_report(
    TIMESTAMPTZ '2026-10-14 00:00:00+03',
    TIMESTAMPTZ '2026-10-21 00:00:00+03'
  );

  SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
    INTO v_tenant_concerns
  FROM public.cc_concern_handling_report(
    TIMESTAMPTZ '2026-10-14 00:00:00+03',
    TIMESTAMPTZ '2026-10-21 00:00:00+03'
  ) r;

  -- Verify tenant report functions still exist with expected signatures
  SELECT p.prosrc INTO v_prosrc_weekly
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'cc_weekly_all_calls_report';

  SELECT p.prosrc INTO v_prosrc_concern
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'cc_concern_handling_report';

  IF v_prosrc_weekly IS NULL OR v_prosrc_concern IS NULL THEN
    RAISE EXCEPTION 'TEST 3 FAILED: tenant report RPCs missing';
  END IF;

  -- Insert a synthetic landlord forwarded concern (48h old -> overdue, on 2026-10-21 15:00+03)
  INSERT INTO public.cc_received_calls (
    id, caller_phone, caller_name, linked_kind, concern, status, called_at, recorded_by, recorded_by_name
  ) VALUES (
    v_recv_id, '256789000111', 'Landlord Concern Caller', 'landlord',
    'Payout number needs verification update', 'open',
    now() - interval '48 hours', v_admin_id, 'Admin Caller'
  );

  INSERT INTO public.cc_forwarded_concerns (
    id, source_kind, received_call_id, subject_type, caller_name,
    title, context, priority, status, forwarded_by, forwarded_by_name,
    forwarded_to, forwarded_to_name, due_at, created_at
  ) VALUES (
    v_fc_id, 'received_call', v_recv_id, 'landlord', 'Landlord Concern Caller',
    'Payout number needs verification update', 'Landlord requested change of payout phone', 'high', 'sent',
    v_admin_id, 'Admin Caller',
    v_admin_id, 'Admin Recipient',
    now() - interval '24 hours', now() - interval '48 hours'
  );

  v_concerns := public.landlord_cc_concerns_report(
    ((now() AT TIME ZONE 'Africa/Kampala')::date - 7),
    (now() AT TIME ZONE 'Africa/Kampala')::date
  );

  IF (v_concerns->'totals'->>'total_concerns')::int < 1
     OR (v_concerns->'totals'->>'overdue_concerns')::int < 1 THEN
    RAISE EXCEPTION 'TEST 3 FAILED: landlord_cc_concerns_report did not count overdue forwarded concern: %',
      v_concerns->'totals';
  END IF;

  -- Verify tenant concern report is completely unaffected
  IF (
    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
    FROM public.cc_concern_handling_report(
      TIMESTAMPTZ '2026-10-14 00:00:00+03',
      TIMESTAMPTZ '2026-10-21 00:00:00+03'
    ) r
  ) <> v_tenant_concerns THEN
    RAISE EXCEPTION 'TEST 3 FAILED: cc_concern_handling_report output changed';
  END IF;

  IF (SELECT count(*) FROM public.cc_weekly_all_calls_report(
        TIMESTAMPTZ '2026-10-14 00:00:00+03',
        TIMESTAMPTZ '2026-10-21 00:00:00+03'
      )) <> v_tenant_all_calls_cnt THEN
    RAISE EXCEPTION 'TEST 3 FAILED: cc_weekly_all_calls_report output changed';
  END IF;

  RAISE NOTICE 'TEST 3 PASSED: concerns_report verified (total_concerns=%, overdue_concerns=%) and tenant reports unchanged',
    v_concerns->'totals'->>'total_concerns', v_concerns->'totals'->>'overdue_concerns';
END
$test3$;

ROLLBACK;

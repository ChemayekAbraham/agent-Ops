-- =============================================================================
-- Test Suite: supabase/tests/staff_assistant_read_tools_batch1.sql
-- Purpose:    Transactional verification of Prompt 4 (Zoe Read Tools Batch 1):
--               1. All 22 assistant_staff_* functions are STABLE, SECURITY DEFINER,
--                  search_path=public, have zero identity parameters, and grant
--                  EXECUTE to authenticated only.
--               2. Phone and National ID masking + 200-row cap helpers work as
--                  specified for roles with and without PII screen visibility.
--               3. For EVERY tool (Questions 1–22):
--                    - Signed-out user is refused with 42501
--                    - User with no role is refused with 42501
--                    - Wrong role is refused with 42501
--                    - Right role gets data that matches the official function,
--                      with 'source', 'period', and at most 200 rows.
--
-- Execution:  Always runs inside BEGIN ... ROLLBACK so zero test data persists.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_fn_rec          record;
  v_fn_count        integer := 0;

  -- Synthetic test users
  v_no_role_uid     uuid := '10000000-0000-4000-8000-000000000301'::uuid;
  v_tenant_uid      uuid := '10000000-0000-4000-8000-000000000302'::uuid;
  v_hr_only_uid     uuid := '10000000-0000-4000-8000-000000000303'::uuid;
  v_pops_only_uid   uuid := '10000000-0000-4000-8000-000000000304'::uuid;
  v_tops_uid        uuid := '10000000-0000-4000-8000-000000000305'::uuid;
  v_lops_uid        uuid := '10000000-0000-4000-8000-000000000306'::uuid;
  v_cfo_uid         uuid := '10000000-0000-4000-8000-000000000307'::uuid;

  v_hr_staff_id     uuid := '10000000-0000-4000-8000-000000000350'::uuid;
  v_today           date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_from            date := ((now() AT TIME ZONE 'Africa/Kampala')::date - 7);
  v_to              date := (now() AT TIME ZONE 'Africa/Kampala')::date;

  v_call_sql        text;
  v_blocked         boolean;
  v_res             jsonb;
  v_off             jsonb;
  v_big_arr         jsonb;
  v_sanitized       jsonb;
BEGIN
  -- ---------------------------------------------------------------------------
  -- 1. Verify metadata & privileges on all 22 assistant_staff_* functions
  -- ---------------------------------------------------------------------------
  FOR v_fn_rec IN
    SELECT
      p.oid,
      p.proname,
      p.provolatile,
      p.prosecdef,
      p.proconfig,
      pg_get_function_arguments(p.oid) AS args,
      pg_get_function_identity_arguments(p.oid) AS id_args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE 'assistant_staff_%'
    ORDER BY p.proname
  LOOP
    v_fn_count := v_fn_count + 1;

    IF v_fn_rec.provolatile <> 's' THEN
      RAISE EXCEPTION 'TEST FAILED: % must be STABLE (got %)', v_fn_rec.proname, v_fn_rec.provolatile;
    END IF;
    IF v_fn_rec.prosecdef IS NOT TRUE THEN
      RAISE EXCEPTION 'TEST FAILED: % must be SECURITY DEFINER', v_fn_rec.proname;
    END IF;
    IF v_fn_rec.proconfig IS NULL OR NOT ('search_path=public' = ANY(v_fn_rec.proconfig)) THEN
      RAISE EXCEPTION 'TEST FAILED: % must set search_path=public (got %)', v_fn_rec.proname, v_fn_rec.proconfig;
    END IF;
    IF v_fn_rec.args ~* '(^|[\s,(])(p_)?(user|agent|tenant|account|owner)_?id\b' THEN
      RAISE EXCEPTION 'TEST FAILED: % has forbidden identity parameter (%))', v_fn_rec.proname, v_fn_rec.args;
    END IF;
    IF has_function_privilege('anon', v_fn_rec.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'TEST FAILED: anon must NOT have EXECUTE on %', v_fn_rec.proname;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn_rec.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'TEST FAILED: authenticated must have EXECUTE on %', v_fn_rec.proname;
    END IF;
  END LOOP;

  IF v_fn_count < 20 THEN
    RAISE EXCEPTION 'TEST FAILED: expected at least 20 assistant_staff_* functions, found %', v_fn_count;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 2. Verify phone/NIN masking and 200-row cap helper
  -- ---------------------------------------------------------------------------
  IF public.staff_assistant_mask_phone('+256701234567', false) <> '+256 7•• ••• 567' THEN
    RAISE EXCEPTION 'TEST FAILED: expected masked phone +256 7•• ••• 567, got %',
      public.staff_assistant_mask_phone('+256701234567', false);
  END IF;
  IF public.staff_assistant_mask_phone('+256701234567', true) <> '+256701234567' THEN
    RAISE EXCEPTION 'TEST FAILED: expected unmasked phone +256701234567, got %',
      public.staff_assistant_mask_phone('+256701234567', true);
  END IF;
  IF public.staff_assistant_mask_nin('CM90123456789ABC', false) <> '•••••••••••ABC' THEN
    RAISE EXCEPTION 'TEST FAILED: expected masked NIN •••••••••••ABC, got %',
      public.staff_assistant_mask_nin('CM90123456789ABC', false);
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'idx', g,
      'tenant_phone', '+256772000' || lpad((g % 1000)::text, 3, '0'),
      'nin', 'CM1234567890' || lpad((g % 100)::text, 2, '0')
    )
  )
  INTO v_big_arr
  FROM generate_series(1, 250) AS g;

  v_sanitized := public.staff_assistant_sanitize_jsonb(v_big_arr, false, 200);
  IF jsonb_array_length(v_sanitized) <> 200 THEN
    RAISE EXCEPTION 'TEST FAILED: expected 250-row array to be capped at 200 rows, got %',
      jsonb_array_length(v_sanitized);
  END IF;
  IF (v_sanitized -> 0 ->> 'tenant_phone') <> '+256 7•• ••• 001' THEN
    RAISE EXCEPTION 'TEST FAILED: expected sanitized phone to be masked, got %',
      (v_sanitized -> 0 ->> 'tenant_phone');
  END IF;
  IF (v_sanitized -> 0 ->> 'nin') <> '•••••••••••001' THEN
    RAISE EXCEPTION 'TEST FAILED: expected sanitized nin to be masked, got %',
      (v_sanitized -> 0 ->> 'nin');
  END IF;

  -- ---------------------------------------------------------------------------
  -- 3. Seed synthetic auth.users + roles + My Space fixtures
  -- ---------------------------------------------------------------------------
  UPDATE public.staff_assistant_config SET enabled = true WHERE id = true;

  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  SELECT
    u.uid,
    'authenticated',
    'authenticated',
    u.em,
    jsonb_build_object('full_name', u.fn, 'phone', u.ph),
    now(),
    now()
  FROM (VALUES
    (v_no_role_uid,   'zoe.norole@welile.com',     'Zoe NoRole User',      '+256799920001'),
    (v_tenant_uid,    'zoe.tenant@welile.com',     'Zoe Tenant Only',      '+256799920002'),
    (v_hr_only_uid,   'zoe.hr.staff@welile.com',   'Zoe HR Staff',         '+256799920003'),
    (v_pops_only_uid, 'zoe.pops.staff@welile.com', 'Zoe PartnerOps Staff', '+256799920004'),
    (v_tops_uid,      'zoe.tops.staff@welile.com', 'Zoe TenantOps Staff',  '+256799920005'),
    (v_lops_uid,      'zoe.lops.staff@welile.com', 'Zoe LandlordOps Staff','+256799920006'),
    (v_cfo_uid,       'zoe.cfo.staff@welile.com',  'Zoe CFO Staff',        '+256799920007')
  ) AS u(uid, em, fn, ph);

  DELETE FROM public.user_roles WHERE user_id IN (
    v_no_role_uid, v_tenant_uid, v_hr_only_uid, v_pops_only_uid,
    v_tops_uid, v_lops_uid, v_cfo_uid
  );

  INSERT INTO public.user_roles (user_id, role, enabled) VALUES
    (v_tenant_uid,    'tenant'::app_role,       true),
    (v_hr_only_uid,   'employee'::app_role,     true),
    (v_hr_only_uid,   'hr'::app_role,           true),
    (v_pops_only_uid, 'partner_ops'::app_role,  true),
    (v_tops_uid,      'tenant_ops'::app_role,   true),
    (v_tops_uid,      'operations'::app_role,   true),
    (v_lops_uid,      'landlord_ops'::app_role, true),
    (v_cfo_uid,       'cfo'::app_role,          true);

  -- Enrol v_hr_only_uid in hr_staff so Group A My Space queries return rich rows
  INSERT INTO public.hr_staff (id, user_id, staff_ref, active)
  VALUES (v_hr_staff_id, v_hr_only_uid, 'WL-ZOE-TEST-303', true);

  -- ---------------------------------------------------------------------------
  -- 4. Signed-out user & no-role user & tenant-only user refused on ALL 22 tools
  -- ---------------------------------------------------------------------------
  FOREACH v_call_sql IN ARRAY ARRAY[
    'SELECT public.assistant_staff_my_profile()',
    'SELECT public.assistant_staff_my_payslips()',
    'SELECT public.assistant_staff_my_tasks()',
    'SELECT public.assistant_staff_my_tickets()',
    'SELECT public.assistant_staff_my_requisitions()',
    'SELECT public.assistant_staff_my_advances()',
    'SELECT public.assistant_staff_my_pending_concerns()',
    'SELECT public.assistant_staff_my_canteen()',
    'SELECT public.assistant_staff_my_wallet()',
    'SELECT public.assistant_staff_tops_first_seven_summary()',
    'SELECT public.assistant_staff_tops_arrears_ageing()',
    'SELECT public.assistant_staff_tops_landlord_not_paid()',
    'SELECT public.assistant_staff_tops_tenant_classification()',
    'SELECT public.assistant_staff_tops_smartphone_usage()',
    'SELECT public.assistant_staff_tops_weekly_performance()',
    'SELECT public.assistant_staff_tops_no_payment_report()',
    'SELECT public.assistant_staff_tops_rent_request_lifetime()',
    'SELECT public.assistant_staff_lops_home_range()',
    'SELECT public.assistant_staff_lops_paid_lists()',
    'SELECT public.assistant_staff_lops_principal_comparison()',
    'SELECT public.assistant_staff_lops_calling_summary()',
    'SELECT public.assistant_staff_lops_calling_coverage()'
  ] LOOP
    -- 4a. Signed-out caller -> must raise 42501
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '{}', true);
    v_blocked := false;
    BEGIN
      EXECUTE v_call_sql INTO v_res;
    EXCEPTION WHEN insufficient_privilege THEN
      v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'TEST FAILED: signed-out caller was not refused (42501) on: %', v_call_sql;
    END IF;

    -- 4b. User with no role -> must raise 42501
    PERFORM set_config('request.jwt.claim.sub', v_no_role_uid::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_no_role_uid::text, 'role', 'authenticated')::text, true);
    v_blocked := false;
    BEGIN
      EXECUTE v_call_sql INTO v_res;
    EXCEPTION WHEN insufficient_privilege THEN
      v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'TEST FAILED: user with no role was not refused (42501) on: %', v_call_sql;
    END IF;

    -- 4c. Tenant-only user -> must raise 42501
    PERFORM set_config('request.jwt.claim.sub', v_tenant_uid::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_tenant_uid::text, 'role', 'authenticated')::text, true);
    v_blocked := false;
    BEGIN
      EXECUTE v_call_sql INTO v_res;
    EXCEPTION WHEN insufficient_privilege THEN
      v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'TEST FAILED: tenant-only caller was not refused (42501) on: %', v_call_sql;
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- 5. Wrong staff role refused on Group B (Tenant Ops) and Group C (Landlord Ops)
  -- ---------------------------------------------------------------------------
  -- 5a. Partner Ops-only staff caller refused on all Tenant Ops (Q10–Q17) & Landlord Ops (Q18–Q22) tools
  PERFORM set_config('request.jwt.claim.sub', v_pops_only_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pops_only_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);

  FOREACH v_call_sql IN ARRAY ARRAY[
    'SELECT public.assistant_staff_tops_first_seven_summary()',
    'SELECT public.assistant_staff_tops_arrears_ageing()',
    'SELECT public.assistant_staff_tops_landlord_not_paid()',
    'SELECT public.assistant_staff_tops_tenant_classification()',
    'SELECT public.assistant_staff_tops_smartphone_usage()',
    'SELECT public.assistant_staff_tops_weekly_performance()',
    'SELECT public.assistant_staff_tops_no_payment_report()',
    'SELECT public.assistant_staff_tops_rent_request_lifetime()',
    'SELECT public.assistant_staff_lops_home_range()',
    'SELECT public.assistant_staff_lops_paid_lists()',
    'SELECT public.assistant_staff_lops_principal_comparison()',
    'SELECT public.assistant_staff_lops_calling_summary()',
    'SELECT public.assistant_staff_lops_calling_coverage()'
  ] LOOP
    v_blocked := false;
    BEGIN
      EXECUTE v_call_sql INTO v_res;
    EXCEPTION WHEN insufficient_privilege THEN
      v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'TEST FAILED: wrong-role (partner_ops) caller was not refused on: %', v_call_sql;
    END IF;
  END LOOP;

  -- 5b. Landlord Ops-only caller refused on Tenant Ops tools; Tenant Ops-only caller refused on Landlord Ops core tools
  PERFORM set_config('request.jwt.claim.sub', v_lops_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_lops_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  v_blocked := false;
  BEGIN
    PERFORM public.assistant_staff_tops_arrears_ageing();
  EXCEPTION WHEN insufficient_privilege THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'TEST FAILED: landlord_ops-only caller must be refused on assistant_staff_tops_arrears_ageing';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_tops_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_tops_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  v_blocked := false;
  BEGIN
    PERFORM public.assistant_staff_lops_paid_lists();
  EXCEPTION WHEN insufficient_privilege THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'TEST FAILED: tenant_ops-only caller must be refused on assistant_staff_lops_paid_lists';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 6. Right role gets data matching official functions — Group A (Q1–Q9)
  -- ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_hr_only_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_hr_only_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);

  -- Q1: assistant_staff_my_profile
  v_res := public.assistant_staff_my_profile();
  IF (v_res ->> 'source') IS NULL OR (v_res -> 'period') IS NULL
     OR (v_res -> 'data' ->> 'staff_ref') <> 'WL-ZOE-TEST-303'
     OR (v_res -> 'data' ->> 'registered_email') <> 'zoe.hr.staff@welile.com'
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_my_profile mismatch: %', v_res;
  END IF;

  -- Q2: assistant_staff_my_payslips
  v_res := public.assistant_staff_my_payslips();
  IF (v_res ->> 'source') <> 'hr_pay_my_payslips' OR (v_res -> 'period') IS NULL
     OR jsonb_array_length(v_res -> 'rows') <> (SELECT count(*) FROM public.hr_pay_my_payslips())
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_my_payslips mismatch: %', v_res;
  END IF;

  -- Q3: assistant_staff_my_tasks
  v_res := public.assistant_staff_my_tasks();
  IF (v_res ->> 'source') <> 'hr_my_staff_id + hr_tasks' OR (v_res -> 'period') IS NULL
     OR jsonb_array_length(v_res -> 'rows') > 200
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_my_tasks mismatch: %', v_res;
  END IF;

  -- Q4: assistant_staff_my_tickets
  v_res := public.assistant_staff_my_tickets();
  IF (v_res ->> 'source') <> 'hr_tickets + hr_ticket_people' OR (v_res -> 'period') IS NULL
     OR jsonb_array_length(v_res -> 'rows') > 200
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_my_tickets mismatch: %', v_res;
  END IF;

  -- Q5: assistant_staff_my_requisitions
  v_res := public.assistant_staff_my_requisitions();
  IF (v_res ->> 'source') <> 'staff_requisitions + staff_requisition_my_notices + get_my_usage_report_notices'
     OR (v_res -> 'period') IS NULL
     OR jsonb_array_length(v_res -> 'rows') > 200
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_my_requisitions mismatch: %', v_res;
  END IF;

  -- Q6: assistant_staff_my_advances
  v_res := public.assistant_staff_my_advances();
  IF (v_res ->> 'source') <> 'hr_pay_advances + hr_pay_advance_recovered_totals'
     OR (v_res -> 'period') IS NULL
     OR jsonb_array_length(v_res -> 'rows') > 200
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_my_advances mismatch: %', v_res;
  END IF;

  -- Q7: assistant_staff_my_pending_concerns
  v_res := public.assistant_staff_my_pending_concerns();
  IF (v_res ->> 'source') <> 'cc_my_pending_concerns'
     OR (v_res -> 'period') IS NULL
     OR jsonb_array_length(v_res -> 'rows') <> (SELECT count(*) FROM public.cc_my_pending_concerns())
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_my_pending_concerns mismatch: %', v_res;
  END IF;

  -- Q8: assistant_staff_my_canteen
  v_res := public.assistant_staff_my_canteen(v_today);
  v_off := public.food_menu_for_day(v_today);
  IF (v_res ->> 'source') <> 'food_menu_for_day + food_orders'
     OR (v_res -> 'data' -> 'menu' ->> 'service_date') <> (v_off ->> 'service_date')
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_my_canteen mismatch: %', v_res;
  END IF;

  -- Q9: assistant_staff_my_wallet
  v_res := public.assistant_staff_my_wallet();
  IF (v_res ->> 'source') <> 'wallets'
     OR (v_res -> 'data' ->> 'balance')::numeric IS DISTINCT FROM coalesce((SELECT balance FROM public.wallets WHERE user_id = v_hr_only_uid LIMIT 1), 0)
     OR (v_res -> 'data' ->> 'withdrawable_balance')::numeric IS DISTINCT FROM coalesce((SELECT withdrawable_balance FROM public.wallets WHERE user_id = v_hr_only_uid LIMIT 1), 0)
     OR (v_res -> 'data' ->> 'float_balance')::numeric IS DISTINCT FROM coalesce((SELECT float_balance FROM public.wallets WHERE user_id = v_hr_only_uid LIMIT 1), 0)
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_my_wallet mismatch: %', v_res;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 7. Right role gets data matching official functions — Group B (Q10–Q17)
  -- ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_tops_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_tops_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);

  -- Q10: assistant_staff_tops_first_seven_summary
  v_res := public.assistant_staff_tops_first_seven_summary(v_from, v_to, NULL);
  v_off := public.am_new_tenant_first7_summary_v2(v_from, v_to, NULL, NULL);
  IF (v_res ->> 'source') <> 'am_new_tenant_first7_summary_v2'
     OR (v_res -> 'data' ->> 'cohort_size') IS DISTINCT FROM (v_off ->> 'cohort_size')
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_tops_first_seven_summary mismatch';
  END IF;

  -- Q11: assistant_staff_tops_arrears_ageing
  v_res := public.assistant_staff_tops_arrears_ageing(v_today, NULL, 10, 0, 'desc');
  v_off := public.tops_arrears_ageing_amclock(v_today, NULL, 10, 0, 'desc');
  IF (v_res ->> 'source') <> 'tops_arrears_ageing_amclock'
     OR (v_res -> 'data' -> 'summary') IS DISTINCT FROM (v_off -> 'summary')
     OR jsonb_array_length(v_res -> 'rows') > 10
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_tops_arrears_ageing mismatch';
  END IF;

  -- Q12: assistant_staff_tops_landlord_not_paid
  v_res := public.assistant_staff_tops_landlord_not_paid(v_today, 10, 0);
  IF (v_res ->> 'source') <> 'tops_landlord_not_paid_summary_amclock + am_uncovered_plans'
     OR (v_res -> 'data' -> 'summary' ->> 'total_plans')::integer IS DISTINCT FROM (
       SELECT total_plans FROM public.tops_landlord_not_paid_summary_amclock() LIMIT 1
     )
     OR jsonb_array_length(v_res -> 'rows') > 10
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_tops_landlord_not_paid mismatch';
  END IF;

  -- Also verify CFO caller sees masked phones on Q11/Q12 while summary figures stay identical
  PERFORM set_config('request.jwt.claim.sub', v_cfo_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cfo_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  IF public.staff_assistant_can_view_pii('tenant_ops') IS TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: cfo caller should have masked phones on tenant_ops screens';
  END IF;
  v_res := public.assistant_staff_tops_landlord_not_paid(v_today, 5, 0);
  IF jsonb_array_length(v_res -> 'rows') > 0
     AND (v_res -> 'rows' -> 0 ->> 'tenant_phone') IS NOT NULL
     AND (v_res -> 'rows' -> 0 ->> 'tenant_phone') NOT LIKE '+256 7•• ••• %'
  THEN
    RAISE EXCEPTION 'TEST FAILED: expected masked tenant_phone for CFO caller, got %',
      (v_res -> 'rows' -> 0 ->> 'tenant_phone');
  END IF;

  -- Switch back to Tenant Ops caller for Q13–Q17
  PERFORM set_config('request.jwt.claim.sub', v_tops_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_tops_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);

  -- Q13: assistant_staff_tops_tenant_classification
  v_res := public.assistant_staff_tops_tenant_classification();
  v_off := public.tops_tenant_classification_summary();
  IF (v_res ->> 'source') <> 'tops_tenant_classification_summary'
     OR (v_res -> 'data' ->> 'population') IS DISTINCT FROM (v_off ->> 'population')
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_tops_tenant_classification mismatch';
  END IF;

  -- Q14: assistant_staff_tops_smartphone_usage
  v_res := public.assistant_staff_tops_smartphone_usage(v_from, v_to);
  v_off := public.tops_smartphone_usage(v_from, v_to);
  IF (v_res ->> 'source') <> 'tops_smartphone_usage'
     OR (v_res -> 'data') IS DISTINCT FROM public.staff_assistant_sanitize_jsonb(v_off, true, 200)
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_tops_smartphone_usage mismatch';
  END IF;

  -- Q15: assistant_staff_tops_weekly_performance
  v_res := public.assistant_staff_tops_weekly_performance(v_today);
  v_off := public.get_tenant_ops_weekly_performance_amclock(v_today);
  IF (v_res ->> 'source') <> 'get_tenant_ops_weekly_performance_amclock'
     OR (v_res -> 'data') IS DISTINCT FROM public.staff_assistant_sanitize_jsonb(v_off, true, 200)
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_tops_weekly_performance mismatch';
  END IF;

  -- Q16: assistant_staff_tops_no_payment_report
  v_res := public.assistant_staff_tops_no_payment_report(20);
  v_off := public.get_tenant_ops_no_payment_report_v2(20, NULL);
  IF (v_res ->> 'source') <> 'get_tenant_ops_no_payment_report_v2'
     OR (v_res -> 'data' ->> 'total_plans') IS DISTINCT FROM (v_off ->> 'total_plans')
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_tops_no_payment_report mismatch';
  END IF;

  -- Q17: assistant_staff_tops_rent_request_lifetime
  v_res := public.assistant_staff_tops_rent_request_lifetime();
  v_off := public.tenant_ops_rent_request_lifetime();
  IF (v_res ->> 'source') <> 'tenant_ops_rent_request_lifetime'
     OR (v_res -> 'data' ->> 'as_at') IS DISTINCT FROM (v_off ->> 'as_at')
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_tops_rent_request_lifetime mismatch';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 8. Right role gets data matching official functions — Group C (Q18–Q22)
  -- ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_lops_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_lops_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);

  -- Q18: assistant_staff_lops_home_range
  v_res := public.assistant_staff_lops_home_range(v_from, v_to);
  v_off := public.ops_landlord_ops_home_range(
    (v_from::timestamp AT TIME ZONE 'Africa/Kampala'),
    (v_to::timestamp AT TIME ZONE 'Africa/Kampala')
  );
  IF (v_res ->> 'source') <> 'ops_landlord_ops_home_range'
     OR (v_res -> 'data' ->> 'total_landlords') IS DISTINCT FROM (v_off ->> 'total_landlords')
     OR (v_res -> 'data' ->> 'paid_amount') IS DISTINCT FROM (v_off ->> 'paid_amount')
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_lops_home_range mismatch';
  END IF;

  -- Q19: assistant_staff_lops_paid_lists
  v_res := public.assistant_staff_lops_paid_lists('paid_repaying', NULL, 10, 0);
  v_off := public.landlord_ops_paid_lists('paid_repaying', NULL, 10, 0);
  IF (v_res ->> 'source') <> 'landlord_ops_paid_lists'
     OR (v_res -> 'data' ->> 'total') IS DISTINCT FROM (v_off ->> 'total')
     OR jsonb_array_length(v_res -> 'rows') > 10
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_lops_paid_lists mismatch';
  END IF;

  -- Q20: assistant_staff_lops_principal_comparison
  v_res := public.assistant_staff_lops_principal_comparison(v_from, v_to);
  v_off := public.landlord_ops_principal_comparison(v_from, v_to);
  IF (v_res ->> 'source') <> 'landlord_ops_principal_comparison + landlord_ops_float_overview'
     OR (v_res -> 'data' -> 'principal_comparison' ->> 'expected') IS DISTINCT FROM (v_off ->> 'expected')
     OR (v_res -> 'data' -> 'principal_comparison' ->> 'recovered') IS DISTINCT FROM (v_off ->> 'recovered')
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_lops_principal_comparison mismatch';
  END IF;

  -- Q21: assistant_staff_lops_calling_summary
  v_res := public.assistant_staff_lops_calling_summary(v_from, v_to, NULL);
  v_off := public.landlord_cc_weekly_report(NULL);
  IF (v_res ->> 'source') <> 'landlord_cc_daily_summary + landlord_cc_weekly_report'
     OR (v_res -> 'data' -> 'weekly_report' ->> 'week_start') IS DISTINCT FROM (v_off ->> 'week_start')
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_lops_calling_summary mismatch';
  END IF;

  -- Q22: assistant_staff_lops_calling_coverage
  v_res := public.assistant_staff_lops_calling_coverage(now());
  IF (v_res ->> 'source') <> 'landlord_cc_coverage'
     OR jsonb_array_length(v_res -> 'rows') > 200
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_lops_calling_coverage mismatch';
  END IF;

  RAISE NOTICE 'ALL ZOE BATCH 1 READ TOOLS TESTS PASSED (% functions verified)', v_fn_count;
END;
$$;

ROLLBACK;

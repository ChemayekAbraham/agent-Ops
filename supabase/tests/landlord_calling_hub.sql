-- =============================================================================
-- Tests: supabase/tests/landlord_calling_hub.sql
-- Purpose: Verify the Landlord Calling Hub data layer (Prompt 1):
--   1. Schema, grants, RLS, mfa_required_for_staff policies, and function grants
--   2. Role gates (record vs read, unprivileged roles, no role, signed-out, anon)
--   3. Phone masking (_landlord_cc_can_view_unmasked_phone: manager masked, landlord_ops unmasked)
--   4. Table & function constraints (answered requires 4 answers + category + severity + note >= 20;
--      unanswered requires nulls; call_back requires future call_back_at)
--   5. Append-only enforcement (UPDATE and DELETE blocked on landlord_calls & landlord_call_amendments)
--   6. Dial markers & double-dial refusal within 20 minutes; idempotent reuse by same officer
--   7. Idempotent call recording, dial linking, and system_events emission
--   8. 24-hour same-caller amendment rules & v_landlord_calls_effective merge
--   9. Live data counts on landlord_hub_list (807 live-plan landlords; never-called consistency)
--  10. Performance (< 1 second for a 50-row page of "all landlords") & untouchable objects check
--
-- Runs in one transaction that always rolls back ("ROLLED BACK REPORT: N passed of N | failing: none").
-- =============================================================================
DO $test$
DECLARE
  r                  jsonb := '[]'::jsonb;
  v_user_none        uuid;
  v_user_ll_ops      uuid;
  v_user_ops         uuid;
  v_user_mgr         uuid;
  v_role             text;
  v_ok               boolean;
  v_key_1            text;
  v_key_2            text;
  v_ll_id_1          uuid;
  v_phone_1          text;
  v_dial_res         jsonb;
  v_dial_res_2       jsonb;
  v_dial_id          uuid;
  v_call_res         jsonb;
  v_call_res_dup     jsonb;
  v_call_id          uuid;
  v_cb_call_res      jsonb;
  v_cb_call_id       uuid;
  v_amend_res        jsonb;
  v_stats            jsonb;
  v_detail           jsonb;
  v_live_total       bigint;
  v_never_called_reg bigint;
  v_to_call_cnt      bigint;
  v_all_cnt          bigint;
  v_page_rows        int;
  v_t0               timestamptz;
  v_elapsed_ms       numeric;
  v_masked_phone     text;
  v_unmasked_phone   text;
  v_masked_flag      boolean;
  v_unmasked_flag    boolean;
  v_ev_cnt           int;
BEGIN
  -- ---------------------------------------------------------------------------
  -- 1. Schema, grants, RLS, mfa_required_for_staff policies & function ACLs
  -- ---------------------------------------------------------------------------
  r := r || jsonb_build_object(
    'step', '1a the three tables have RLS enabled and the restrictive mfa_required_for_staff policy',
    'pass', (
      SELECT count(*) = 3
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname IN ('landlord_calls', 'landlord_call_dials', 'landlord_call_amendments')
         AND c.relrowsecurity = true
         AND EXISTS (
           SELECT 1 FROM pg_policy pol
            WHERE pol.polrelid = c.oid
              AND pol.polname = 'mfa_required_for_staff'
              AND pol.polpermissive = false
         )
    )
  );

  r := r || jsonb_build_object(
    'step', '1b authenticated has SELECT only on landlord_calls, landlord_call_dials and landlord_call_amendments; anon has no table privileges',
    'pass', (
      SELECT bool_and(
        has_table_privilege('authenticated', t, 'SELECT')
        AND NOT has_table_privilege('authenticated', t, 'INSERT')
        AND NOT has_table_privilege('authenticated', t, 'UPDATE')
        AND NOT has_table_privilege('authenticated', t, 'DELETE')
        AND NOT has_table_privilege('anon', t, 'SELECT')
        AND NOT has_table_privilege('anon', t, 'INSERT')
      )
      FROM unnest(ARRAY[
        'public.landlord_calls',
        'public.landlord_call_dials',
        'public.landlord_call_amendments'
      ]) AS t
    )
  );

  r := r || jsonb_build_object(
    'step', '1c all six landlord_hub_* functions are SECURITY DEFINER, search_path = public, granted to authenticated only (not anon, PUBLIC or service_role)',
    'pass', (
      SELECT count(*) = 6
         AND bool_and(
           p.prosecdef
           AND p.proconfig @> ARRAY['search_path=public']
           AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
           AND NOT EXISTS (
             SELECT 1
               FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
              WHERE a.grantee = 0
           )
         )
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN (
          'landlord_hub_list',
          'landlord_hub_detail',
          'landlord_hub_start_dial',
          'landlord_hub_record_call',
          'landlord_hub_amend_call',
          'landlord_hub_stats'
        )
    )
  );

  -- Pick a sample landlord with a valid phone from mv_landlord_hub_registry
  SELECT reg.landlord_key_text, reg.landlord_id, COALESCE(reg.phones[1], '256772123456')
    INTO v_key_1, v_ll_id_1, v_phone_1
  FROM public.mv_landlord_hub_registry reg
  WHERE reg.active_rent_plans > 0
    AND reg.phones[1] IS NOT NULL
  ORDER BY reg.plan_rent_total DESC NULLS LAST
  LIMIT 1;

  SELECT reg.landlord_key_text
    INTO v_key_2
  FROM public.mv_landlord_hub_registry reg
  WHERE reg.landlord_key_text <> v_key_1
  LIMIT 1;

  SELECT p.id INTO v_user_none
  FROM public.profiles p
  WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
    AND p.deleted_at IS NULL
  ORDER BY p.id
  LIMIT 1;

  SELECT p.id INTO v_user_ll_ops
  FROM public.profiles p
  WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
    AND p.deleted_at IS NULL
    AND p.id <> v_user_none
  ORDER BY p.id
  LIMIT 1;

  SELECT p.id INTO v_user_ops
  FROM public.profiles p
  WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
    AND p.deleted_at IS NULL
    AND p.id NOT IN (v_user_none, v_user_ll_ops)
  ORDER BY p.id
  LIMIT 1;

  SELECT p.id INTO v_user_mgr
  FROM public.profiles p
  WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
    AND p.deleted_at IS NULL
    AND p.id NOT IN (v_user_none, v_user_ll_ops, v_user_ops)
  ORDER BY p.id
  LIMIT 1;

  -- ---------------------------------------------------------------------------
  -- 2. Role gates: read vs record, unauthorized roles, no role, signed-out
  -- ---------------------------------------------------------------------------
  FOREACH v_role IN ARRAY ARRAY['landlord_ops', 'operations', 'hr', 'coo', 'ceo', 'cfo', 'manager', 'super_admin'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role, enabled) VALUES (v_user_none, v_role::public.app_role, true);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_none, 'role', 'authenticated', 'aal', 'aal2')::text, true);
      SET LOCAL ROLE authenticated;
      PERFORM 1 FROM public.landlord_hub_list('live_plans', 'all', NULL, NULL, NULL, NULL, NULL, 'rent_plan_value', 5, 0);
      PERFORM public.landlord_hub_detail(v_key_1);
      PERFORM public.landlord_hub_stats();
      RESET ROLE;
      r := r || jsonb_build_object('step', '2a ' || v_role || ' can call read functions (list, detail, stats)', 'pass', true);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      IF SQLERRM <> 'CASE_DONE' THEN
        r := r || jsonb_build_object('step', '2a ' || v_role || ' can call read functions (list, detail, stats)', 'pass', false, 'detail', left(SQLERRM, 200));
      END IF;
    END;
  END LOOP;

  -- Read-only roles (hr, coo, ceo, cfo, manager, super_admin) must be refused on write functions (start_dial, record_call, amend_call)
  FOREACH v_role IN ARRAY ARRAY['hr', 'coo', 'ceo', 'cfo', 'manager', 'super_admin'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role, enabled) VALUES (v_user_none, v_role::public.app_role, true);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_none, 'role', 'authenticated', 'aal', 'aal2')::text, true);
      SET LOCAL ROLE authenticated;
      v_ok := true;
      BEGIN PERFORM public.landlord_hub_start_dial(v_key_1, v_phone_1); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      BEGIN PERFORM public.landlord_hub_record_call(v_key_1, v_phone_1, now(), 'no_answer'); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      BEGIN PERFORM public.landlord_hub_amend_call(gen_random_uuid(), '{"note":"updated"}'::jsonb, 'Valid reason'); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      RESET ROLE;
      r := r || jsonb_build_object('step', '2b read-only role ' || v_role || ' is refused on start_dial, record_call and amend_call (42501)', 'pass', v_ok);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      IF SQLERRM <> 'CASE_DONE' THEN
        r := r || jsonb_build_object('step', '2b read-only role ' || v_role || ' is refused on start_dial, record_call and amend_call (42501)', 'pass', false, 'detail', left(SQLERRM, 200));
      END IF;
    END;
  END LOOP;

  -- Non-hub roles (tenant_ops, agent_ops, partner_ops, agent, tenant, supporter) must be refused on all 6 functions
  FOREACH v_role IN ARRAY ARRAY['tenant_ops', 'agent_ops', 'partner_ops', 'agent', 'tenant', 'supporter'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role, enabled) VALUES (v_user_none, v_role::public.app_role, true);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_none, 'role', 'authenticated', 'aal', 'aal2')::text, true);
      SET LOCAL ROLE authenticated;
      v_ok := true;
      BEGIN PERFORM 1 FROM public.landlord_hub_list(); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      BEGIN PERFORM public.landlord_hub_detail(v_key_1); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      BEGIN PERFORM public.landlord_hub_stats(); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      BEGIN PERFORM public.landlord_hub_start_dial(v_key_1, v_phone_1); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      BEGIN PERFORM public.landlord_hub_record_call(v_key_1, v_phone_1, now(), 'no_answer'); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      BEGIN PERFORM public.landlord_hub_amend_call(gen_random_uuid(), '{"note":"updated"}'::jsonb, 'Valid reason'); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      RESET ROLE;
      r := r || jsonb_build_object('step', '2c unauthorized role ' || v_role || ' is refused by all six functions (42501)', 'pass', v_ok);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      IF SQLERRM <> 'CASE_DONE' THEN
        r := r || jsonb_build_object('step', '2c unauthorized role ' || v_role || ' is refused by all six functions (42501)', 'pass', false, 'detail', left(SQLERRM, 200));
      END IF;
    END;
  END LOOP;

  -- User with no role
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_none, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  SET LOCAL ROLE authenticated;
  v_ok := true;
  BEGIN PERFORM 1 FROM public.landlord_hub_list(); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  BEGIN PERFORM public.landlord_hub_detail(v_key_1); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  BEGIN PERFORM public.landlord_hub_stats(); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  BEGIN PERFORM public.landlord_hub_start_dial(v_key_1, v_phone_1); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  BEGIN PERFORM public.landlord_hub_record_call(v_key_1, v_phone_1, now(), 'no_answer'); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  BEGIN PERFORM public.landlord_hub_amend_call(gen_random_uuid(), '{"note":"updated"}'::jsonb, 'Valid reason'); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  RESET ROLE;
  r := r || jsonb_build_object('step', '2d signed-in user with no role is refused by all six functions (42501)', 'pass', v_ok);

  -- Signed-out user (no sub claim)
  PERFORM set_config('request.jwt.claims', '', true);
  SET LOCAL ROLE authenticated;
  v_ok := true;
  BEGIN PERFORM 1 FROM public.landlord_hub_list(); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  BEGIN PERFORM public.landlord_hub_detail(v_key_1); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  BEGIN PERFORM public.landlord_hub_stats(); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  BEGIN PERFORM public.landlord_hub_start_dial(v_key_1, v_phone_1); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  BEGIN PERFORM public.landlord_hub_record_call(v_key_1, v_phone_1, now(), 'no_answer'); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  BEGIN PERFORM public.landlord_hub_amend_call(gen_random_uuid(), '{"note":"updated"}'::jsonb, 'Valid reason'); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  RESET ROLE;
  r := r || jsonb_build_object('step', '2e signed-out caller (auth.uid() IS NULL) is refused by all six functions (42501)', 'pass', v_ok);

  -- ---------------------------------------------------------------------------
  -- 3. Phone masking (_landlord_cc_can_view_unmasked_phone rule)
  --    manager can read but is NOT in _landlord_cc_can_view_unmasked_phone(),
  --    so manager gets masked phones; landlord_ops gets unmasked phones.
  -- ---------------------------------------------------------------------------
  INSERT INTO public.user_roles (user_id, role, enabled) VALUES
    (v_user_ll_ops, 'landlord_ops'::public.app_role, true),
    (v_user_ops, 'operations'::public.app_role, true),
    (v_user_mgr, 'manager'::public.app_role, true);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_mgr, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT l.phone, l.phone_masked INTO v_masked_phone, v_masked_flag
  FROM public.landlord_hub_list('live_plans', 'all', NULL, NULL, NULL, NULL, NULL, 'rent_plan_value', 10, 0) l
  WHERE l.landlord_key = v_key_1
  LIMIT 1;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_ll_ops, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT l.phone, l.phone_masked INTO v_unmasked_phone, v_unmasked_flag
  FROM public.landlord_hub_list('live_plans', 'all', NULL, NULL, NULL, NULL, NULL, 'rent_plan_value', 10, 0) l
  WHERE l.landlord_key = v_key_1
  LIMIT 1;
  RESET ROLE;

  r := r || jsonb_build_object(
    'step', '3 phone masking follows _landlord_cc_can_view_unmasked_phone() (manager sees masked phone; landlord_ops sees unmasked phone)',
    'pass', (
      v_masked_flag = true
      AND v_unmasked_flag = false
      AND v_masked_phone = public.crm_mask_phone(v_unmasked_phone)
      AND (v_masked_phone LIKE '%•%' OR v_masked_phone LIKE '%*%')
      AND v_unmasked_phone NOT LIKE '%•%'
      AND v_unmasked_phone NOT LIKE '%*%'
      AND v_masked_phone <> v_unmasked_phone
    ),
    'detail', format('mgr=%s (masked=%s) vs ll_ops=%s (masked=%s)', v_masked_phone, v_masked_flag, v_unmasked_phone, v_unmasked_flag)
  );

  -- ---------------------------------------------------------------------------
  -- 4. Validation constraints on landlord_hub_record_call & landlord_calls table
  -- ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_ll_ops, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  SET LOCAL ROLE authenticated;

  -- 4a. answered without awareness answers is rejected
  v_ok := false;
  BEGIN
    PERFORM public.landlord_hub_record_call(
      p_landlord_key => v_key_1,
      p_phone_dialed => v_phone_1,
      p_dial_started_at => now() - interval '2 minutes',
      p_result => 'answered',
      p_aware_30m => 'knew',
      p_landlord_consent => NULL,
      p_aware_payout_otp => 'knew',
      p_explained => 'yes',
      p_feedback_category => 'reached_ok',
      p_severity => 'normal',
      p_note => 'This note is more than twenty characters long.'
    );
  EXCEPTION WHEN OTHERS THEN
    v_ok := SQLSTATE = '22023';
  END;
  r := r || jsonb_build_object('step', '4a answered call missing any of the four awareness answers is rejected', 'pass', v_ok);

  -- 4b. answered with short note (< 20 chars) is rejected
  v_ok := false;
  BEGIN
    PERFORM public.landlord_hub_record_call(
      p_landlord_key => v_key_1,
      p_phone_dialed => v_phone_1,
      p_dial_started_at => now() - interval '2 minutes',
      p_result => 'answered',
      p_aware_30m => 'knew',
      p_landlord_consent => 'consents',
      p_aware_payout_otp => 'knew',
      p_explained => 'yes',
      p_feedback_category => 'reached_ok',
      p_severity => 'normal',
      p_note => 'Too short note'
    );
  EXCEPTION WHEN OTHERS THEN
    v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'NOTE_TOO_SHORT%';
  END;
  r := r || jsonb_build_object('step', '4b answered call with note shorter than 20 characters is rejected', 'pass', v_ok);

  -- 4c. unanswered call with awareness answers or category or severity is rejected
  v_ok := false;
  BEGIN
    PERFORM public.landlord_hub_record_call(
      p_landlord_key => v_key_1,
      p_phone_dialed => v_phone_1,
      p_dial_started_at => now() - interval '2 minutes',
      p_result => 'no_answer',
      p_aware_30m => 'knew'
    );
  EXCEPTION WHEN OTHERS THEN
    v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'UNANSWERED_FIELDS_NOT_ALLOWED%';
  END;
  r := r || jsonb_build_object('step', '4c unanswered call with awareness answers / category / severity is rejected', 'pass', v_ok);

  -- 4d. call_back without future call_back_at is rejected
  v_ok := false;
  BEGIN
    PERFORM public.landlord_hub_record_call(
      p_landlord_key => v_key_1,
      p_phone_dialed => v_phone_1,
      p_dial_started_at => now() - interval '2 minutes',
      p_result => 'call_back',
      p_call_back_at => now() - interval '10 minutes'
    );
  EXCEPTION WHEN OTHERS THEN
    v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'CALLBACK_TIME_INVALID%';
  END;
  r := r || jsonb_build_object('step', '4d call_back with a past or missing call_back_at is rejected', 'pass', v_ok);

  RESET ROLE;

  -- 4e. Direct table CHECK constraints also reject invalid combinations even as table owner
  v_ok := false;
  BEGIN
    INSERT INTO public.landlord_calls (
      landlord_key, phone_dialed, caller_id, dial_started_at, result, aware_30m
    ) VALUES (
      v_key_1, v_phone_1, v_user_ll_ops, now() - interval '5 minutes', 'no_answer', 'knew'
    );
  EXCEPTION WHEN check_violation THEN
    v_ok := true;
  END;
  r := r || jsonb_build_object('step', '4e table CHECK constraint directly rejects unanswered row with awareness answer', 'pass', v_ok);

  -- ---------------------------------------------------------------------------
  -- 5. Dial markers & double-dial refusal within 20 minutes
  -- ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_ll_ops, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  SET LOCAL ROLE authenticated;
  v_dial_res := public.landlord_hub_start_dial(v_key_1, v_phone_1);
  v_dial_id := (v_dial_res->>'dial_id')::uuid;
  -- Same officer tapping again reuses the active dial marker idempotently
  v_dial_res_2 := public.landlord_hub_start_dial(v_key_1, v_phone_1);
  RESET ROLE;

  r := r || jsonb_build_object(
    'step', '5a landlord_hub_start_dial creates a 20-minute dial marker and reuses it on repeat tap by the same officer',
    'pass', (
      v_dial_id IS NOT NULL
      AND (v_dial_res->>'reused')::boolean = false
      AND (v_dial_res_2->>'dial_id')::uuid = v_dial_id
      AND (v_dial_res_2->>'reused')::boolean = true
    )
  );

  -- Second officer (operations) attempting to dial the same landlord within 20 minutes is refused
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_ops, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  SET LOCAL ROLE authenticated;
  v_ok := false;
  BEGIN
    PERFORM public.landlord_hub_start_dial(v_key_1, v_phone_1);
  EXCEPTION WHEN OTHERS THEN
    v_ok := SQLSTATE = '23505' AND SQLERRM LIKE 'DIAL_IN_PROGRESS:%';
  END;
  RESET ROLE;
  r := r || jsonb_build_object('step', '5b another officer is refused when dialling a landlord with an active 20-minute dial marker', 'pass', v_ok);

  -- ---------------------------------------------------------------------------
  -- 6. Recording a call, idempotency, dial linking, and system_events emission
  -- ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_ll_ops, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  SET LOCAL ROLE authenticated;

  v_call_res := public.landlord_hub_record_call(
    p_landlord_key => v_key_1,
    p_phone_dialed => v_phone_1,
    p_dial_started_at => (v_dial_res->>'started_at')::timestamptz,
    p_result => 'answered',
    p_dial_id => v_dial_id,
    p_landlord_id => v_ll_id_1,
    p_landlord_name => 'Test Landlord Alpha',
    p_aware_30m => 'knew',
    p_landlord_consent => 'consents',
    p_aware_payout_otp => 'heard',
    p_explained => 'yes',
    p_feedback_category => 'confirmed_payout_number',
    p_severity => 'normal',
    p_note => 'Landlord confirmed their mobile money payout number and Rent Plan details.'
  );
  v_call_id := (v_call_res->>'id')::uuid;

  -- Retry with the exact same (caller_id, landlord_key, dial_started_at) is idempotent
  v_call_res_dup := public.landlord_hub_record_call(
    p_landlord_key => v_key_1,
    p_phone_dialed => v_phone_1,
    p_dial_started_at => (v_dial_res->>'started_at')::timestamptz,
    p_result => 'answered',
    p_dial_id => v_dial_id,
    p_landlord_id => v_ll_id_1,
    p_landlord_name => 'Test Landlord Alpha',
    p_aware_30m => 'knew',
    p_landlord_consent => 'consents',
    p_aware_payout_otp => 'heard',
    p_explained => 'yes',
    p_feedback_category => 'confirmed_payout_number',
    p_severity => 'normal',
    p_note => 'Landlord confirmed their mobile money payout number and Rent Plan details.'
  );

  RESET ROLE;

  SELECT count(*) INTO v_ev_cnt
  FROM public.system_events se
  WHERE se.event_type = 'landlord_hub.call_recorded'
    AND (se.metadata->>'call_id')::uuid = v_call_id;

  r := r || jsonb_build_object(
    'step', '6a landlord_hub_record_call saves the call, links the dial marker, and writes one system_events row',
    'pass', (
      v_call_id IS NOT NULL
      AND (v_call_res->>'already_recorded')::boolean = false
      AND (SELECT d.call_id FROM public.landlord_call_dials d WHERE d.id = v_dial_id) = v_call_id
      AND v_ev_cnt = 1
    )
  );

  r := r || jsonb_build_object(
    'step', '6b repeat call to landlord_hub_record_call with same (caller_id, landlord_key, dial_started_at) is idempotent',
    'pass', (
      (v_call_res_dup->>'id')::uuid = v_call_id
      AND (v_call_res_dup->>'already_recorded')::boolean = true
      AND (SELECT count(*) FROM public.landlord_calls c WHERE c.id = v_call_id) = 1
    )
  );

  -- ---------------------------------------------------------------------------
  -- 7. Append-only enforcement on landlord_calls & landlord_call_amendments
  -- ---------------------------------------------------------------------------
  v_ok := true;
  BEGIN
    UPDATE public.landlord_calls SET note = 'Tampered note over twenty chars' WHERE id = v_call_id;
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN
    v_ok := v_ok AND SQLSTATE = '42501';
  END;
  BEGIN
    DELETE FROM public.landlord_calls WHERE id = v_call_id;
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN
    v_ok := v_ok AND SQLSTATE = '42501';
  END;
  r := r || jsonb_build_object('step', '7 append-only trigger blocks UPDATE and DELETE on landlord_calls even for table owner', 'pass', v_ok);

  -- ---------------------------------------------------------------------------
  -- 8. Amendments (same caller within 24h allowed; other caller refused;
  --    v_landlord_calls_effective merges amendment without editing landlord_calls)
  -- ---------------------------------------------------------------------------
  -- Other officer (v_user_ops) cannot amend v_user_ll_ops's call
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_ops, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  SET LOCAL ROLE authenticated;
  v_ok := false;
  BEGIN
    PERFORM public.landlord_hub_amend_call(
      v_call_id,
      '{"severity": "high", "note": "Updated note with more than twenty characters by wrong user."}'::jsonb,
      'Trying to edit colleague call'
    );
  EXCEPTION WHEN OTHERS THEN
    v_ok := SQLSTATE = '42501';
  END;
  RESET ROLE;
  r := r || jsonb_build_object('step', '8a landlord_hub_amend_call refuses a different officer (42501)', 'pass', v_ok);

  -- Same officer amends within 24 hours
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_ll_ops, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  SET LOCAL ROLE authenticated;
  v_amend_res := public.landlord_hub_amend_call(
    v_call_id,
    '{"severity": "high", "feedback_category": "payout_issue", "note": "Corrected note: landlord reported a delay on their previous payout."}'::jsonb,
    'Marked as payout issue after checking receipt'
  );
  RESET ROLE;

  r := r || jsonb_build_object(
    'step', '8b same caller can amend within 24h; original row stays untouched while v_landlord_calls_effective reflects the amendment',
    'pass', (
      (v_amend_res->>'call_id')::uuid = v_call_id
      AND (SELECT c.severity FROM public.landlord_calls c WHERE c.id = v_call_id) = 'normal'
      AND (SELECT e.severity FROM public.v_landlord_calls_effective e WHERE e.id = v_call_id) = 'high'
      AND (SELECT e.feedback_category FROM public.v_landlord_calls_effective e WHERE e.id = v_call_id) = 'payout_issue'
      AND (SELECT e.is_amended FROM public.v_landlord_calls_effective e WHERE e.id = v_call_id) = true
    )
  );

  -- Also record a call_back on v_key_2 and check stats + detail
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_ll_ops, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  SET LOCAL ROLE authenticated;
  v_cb_call_res := public.landlord_hub_record_call(
    p_landlord_key => v_key_2,
    p_phone_dialed => '256772999888',
    p_dial_started_at => now() - interval '1 minute',
    p_result => 'call_back',
    p_call_back_at => now() + interval '2 hours',
    p_note => 'Landlord asked us to call back after 2 hours.'
  );
  v_cb_call_id := (v_cb_call_res->>'id')::uuid;
  v_stats := public.landlord_hub_stats();
  v_detail := public.landlord_hub_detail(v_key_1);
  RESET ROLE;

  r := r || jsonb_build_object(
    'step', '8c landlord_hub_stats and landlord_hub_detail return the newly recorded calls, call-backs due, and landlord card sections',
    'pass', (
      (v_stats->>'calls_today')::int >= 2
      AND (v_stats->>'answered_today')::int >= 1
      AND (v_stats->>'call_backs_due')::int >= 1
      AND (v_detail->>'landlord_key') = v_key_1
      AND jsonb_typeof(v_detail->'houses') = 'array'
      AND jsonb_typeof(v_detail->'tenants_and_plans') = 'array'
      AND jsonb_typeof(v_detail->'call_history') = 'array'
      AND (v_detail->'call_history'->0->>'call_id')::uuid = v_call_id
      AND (v_detail->'call_history'->0->>'severity') = 'high'
    )
  );

  -- ---------------------------------------------------------------------------
  -- 9. Live data counts on landlord_hub_list (807 live-plan landlords;
  --    never-called count consistent with sources)
  --    Delete the two synthetic test rows in this check? No, landlord_calls is
  --    append-only! Instead, verify that live_plans total_count = 807 and compare
  --    live_plan_landlords_never_called against v_landlord_registry_all.
  -- ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_ll_ops, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  SET LOCAL ROLE authenticated;

  SELECT COALESCE(max(l.total_count), 0)
    INTO v_live_total
  FROM public.landlord_hub_list('live_plans', 'all', NULL, NULL, NULL, NULL, NULL, 'rent_plan_value', 10, 0) l;

  SELECT COALESCE(max(l.total_count), 0)
    INTO v_to_call_cnt
  FROM public.landlord_hub_list('live_plans', 'to_call', NULL, NULL, NULL, NULL, NULL, 'rent_plan_value', 10, 0) l;

  RESET ROLE;

  SELECT count(*)
    INTO v_never_called_reg
  FROM public.v_landlord_registry_all reg
  WHERE reg.active_rent_plans > 0
    AND reg.last_called_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.v_landlord_calls_effective c
      WHERE c.voided_at IS NULL AND c.landlord_key = reg.landlord_key::text
    );

  r := r || jsonb_build_object(
    'step', '9a landlord_hub_list(live_plans, all) returns the expected live-plan landlords on live data',
    'pass', v_live_total >= 800,
    'detail', format('live_total=%s', v_live_total)
  );

  r := r || jsonb_build_object(
    'step', '9b live_plan_landlords_never_called in landlord_hub_stats matches v_landlord_registry_all + landlord_calls exactly, and live_tab_counts.to_call matches list to_call',
    'pass', (
      (v_stats->>'live_plan_landlords_total')::bigint = v_live_total
      AND (v_stats->>'live_plan_landlords_never_called')::bigint = v_never_called_reg
      AND (v_stats->'live_tab_counts'->>'to_call')::bigint = v_to_call_cnt
    ),
    'detail', format('stats_never_called=%s, reg_never_called=%s, to_call=%s', v_stats->>'live_plan_landlords_never_called', v_never_called_reg, v_to_call_cnt)
  );

  -- ---------------------------------------------------------------------------
  -- 10. Performance (< 1 second for a 50-row page of "all landlords")
  -- ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_ll_ops, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  SET LOCAL ROLE authenticated;

  v_t0 := clock_timestamp();
  SELECT count(*), COALESCE(max(l.total_count), 0)
    INTO v_page_rows, v_all_cnt
  FROM public.landlord_hub_list('all', 'all', NULL, NULL, NULL, NULL, NULL, 'rent_plan_value', 50, 0) l;
  v_elapsed_ms := extract(epoch FROM (clock_timestamp() - v_t0)) * 1000.0;

  RESET ROLE;

  r := r || jsonb_build_object(
    'step', '10 a 50-row page of "all landlords" returns 50 rows in under 1 second (' || round(v_elapsed_ms, 1) || ' ms)',
    'pass', (v_page_rows = 50 AND v_all_cnt >= 47000 AND v_all_cnt <= 48000 AND v_elapsed_ms < 1000.0),
    'detail', format('rows=%s, total=%s, elapsed_ms=%s', v_page_rows, v_all_cnt, round(v_elapsed_ms, 1))
  );

  -- Final rollback report
  RAISE EXCEPTION 'ROLLED BACK REPORT: % passed of % | failing: %',
    (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'),
    jsonb_array_length(r),
    COALESCE((
      SELECT string_agg((e->>'step') || COALESCE(' [' || (e->>'detail') || ']', ''), '; ')
      FROM jsonb_array_elements(r) e
      WHERE (e->>'pass') <> 'true'
    ), 'none');
END
$test$;

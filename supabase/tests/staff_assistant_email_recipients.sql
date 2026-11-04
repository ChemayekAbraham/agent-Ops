-- =============================================================================
-- Test Suite: supabase/tests/staff_assistant_email_recipients.sql
-- Purpose:    Transactional verification of Prompt 3 (Zoe Staff Email Recipients):
--               1. Function attributes (STABLE, SECURITY DEFINER, search_path=public)
--                  and EXECUTE grants (authenticated only, revoked from anon/public).
--               2. Staff found: enabled staff caller finds staff recipients by
--                  name or email (up to 10 rows) with (staff_user_id, full_name,
--                  email, roles), and staff_assistant_is_staff_email returns true.
--               3. Staff with empty or synthetic placeholder email (@welile.user)
--                  or disabled staff role are excluded.
--               4. A tenant's email (and agent / landlord / Supporter-only email)
--                  is NOT found in staff_assistant_email_recipients and returns
--                  false from staff_assistant_is_staff_email.
--               5. A non-staff caller (tenant, agent, landlord, Supporter,
--                  disabled staff, or unauthenticated) gets 0 rows and false.
--               6. When staff_assistant_config.enabled = false, even staff callers
--                  get 0 rows and false.
--
-- Execution:  Always runs inside BEGIN ... ROLLBACK so zero test data persists.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_fn_name         text;
  v_provolatile     "char";
  v_prosecdef       boolean;
  v_proconfig       text[];

  -- Synthetic test user UUIDs
  v_caller_staff    uuid := '10000000-0000-4000-8000-000000000201'::uuid;
  v_target_staff_1  uuid := '10000000-0000-4000-8000-000000000202'::uuid;
  v_target_staff_2  uuid := '10000000-0000-4000-8000-000000000203'::uuid;
  v_staff_no_email  uuid := '10000000-0000-4000-8000-000000000204'::uuid;
  v_staff_synth_em  uuid := '10000000-0000-4000-8000-000000000205'::uuid;
  v_staff_disabled  uuid := '10000000-0000-4000-8000-000000000206'::uuid;
  v_tenant_user     uuid := '10000000-0000-4000-8000-000000000207'::uuid;
  v_agent_user      uuid := '10000000-0000-4000-8000-000000000208'::uuid;
  v_landlord_user   uuid := '10000000-0000-4000-8000-000000000209'::uuid;
  v_supporter_user  uuid := '10000000-0000-4000-8000-000000000210'::uuid;

  v_count           integer;
  v_rec             record;
  v_non_staff_uid   uuid;
BEGIN
  -- ---------------------------------------------------------------------------
  -- 1. Verify STABLE, SECURITY DEFINER, search_path=public, and EXECUTE grants
  -- ---------------------------------------------------------------------------
  FOREACH v_fn_name IN ARRAY ARRAY[
    'staff_assistant_email_recipients',
    'staff_assistant_is_staff_email'
  ] LOOP
    SELECT p.provolatile, p.prosecdef, p.proconfig
      INTO v_provolatile, v_prosecdef, v_proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_fn_name;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'TEST FAILED: function public.% does not exist', v_fn_name;
    END IF;
    IF v_provolatile <> 's' THEN
      RAISE EXCEPTION 'TEST FAILED: % must be STABLE (got %)', v_fn_name, v_provolatile;
    END IF;
    IF v_prosecdef IS NOT TRUE THEN
      RAISE EXCEPTION 'TEST FAILED: % must be SECURITY DEFINER', v_fn_name;
    END IF;
    IF v_proconfig IS NULL OR NOT ('search_path=public' = ANY(v_proconfig)) THEN
      RAISE EXCEPTION 'TEST FAILED: % must set search_path=public (got %)', v_fn_name, v_proconfig;
    END IF;

    IF has_function_privilege('anon', format('public.%I(text)', v_fn_name), 'EXECUTE') THEN
      RAISE EXCEPTION 'TEST FAILED: anon must NOT have EXECUTE on %(text)', v_fn_name;
    END IF;
    IF NOT has_function_privilege('authenticated', format('public.%I(text)', v_fn_name), 'EXECUTE') THEN
      RAISE EXCEPTION 'TEST FAILED: authenticated must have EXECUTE on %(text)', v_fn_name;
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- 2. Seed synthetic auth.users, profiles, and user_roles for testing
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
    (v_caller_staff,   'zoe.caller.staff@welile.com',     'Zoe Caller Staff',     '+256799910001'),
    (v_target_staff_1, 'zoe.alice.ops@welile.com',        'Zoe Alice Mukasa',     '+256799910002'),
    (v_target_staff_2, 'zoe.brian.finance@welile.com',    'Zoe Brian Okello',     '+256799910003'),
    (v_staff_no_email, '0799910004@welile.user',          'Zoe NoEmail Staff',    '+256799910004'),
    (v_staff_synth_em, '256799910005@welile.user',        'Zoe SynthEmail Staff', '+256799910005'),
    (v_staff_disabled, 'zoe.disabled.staff@welile.com',   'Zoe Disabled Staff',   '+256799910006'),
    (v_tenant_user,    'zoe.tenant.person@gmail.com',     'Zoe Tenant Person',    '+256799910007'),
    (v_agent_user,     'zoe.agent.person@gmail.com',      'Zoe Agent Person',     '+256799910008'),
    (v_landlord_user,  'zoe.landlord.person@gmail.com',   'Zoe Landlord Person',  '+256799910009'),
    (v_supporter_user, 'zoe.supporter.person@gmail.com',  'Zoe Supporter Person', '+256799910010')
  ) AS u(uid, em, fn, ph);

  -- Make v_staff_no_email have an empty profile email while v_staff_synth_em keeps @welile.user
  UPDATE public.profiles SET email = '' WHERE id = v_staff_no_email;

  -- Clear trigger-assigned default roles on synthetic users
  DELETE FROM public.user_roles WHERE user_id IN (
    v_caller_staff, v_target_staff_1, v_target_staff_2, v_staff_no_email,
    v_staff_synth_em, v_staff_disabled, v_tenant_user, v_agent_user,
    v_landlord_user, v_supporter_user
  );

  INSERT INTO public.user_roles (user_id, role, enabled) VALUES
    (v_caller_staff,   'hr'::app_role,            true),
    (v_target_staff_1, 'tenant_ops'::app_role,    true),
    (v_target_staff_1, 'landlord_ops'::app_role,  true),
    (v_target_staff_1, 'tenant'::app_role,        true), -- public role must NOT appear in staff roles[]
    (v_target_staff_2, 'financial_ops'::app_role, true),
    (v_staff_no_email, 'agent_ops'::app_role,     true),
    (v_staff_synth_em, 'partner_ops'::app_role,   true),
    (v_staff_disabled, 'tenant_ops'::app_role,    false),
    (v_tenant_user,    'tenant'::app_role,        true),
    (v_agent_user,     'agent'::app_role,         true),
    (v_landlord_user,  'landlord'::app_role,      true),
    (v_supporter_user, 'supporter'::app_role,     true);

  -- ---------------------------------------------------------------------------
  -- 3. Authenticate as enabled staff caller (v_caller_staff)
  -- ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_caller_staff::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_caller_staff::text, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  -- 3a. Staff found by name search
  SELECT *
    INTO v_rec
    FROM public.staff_assistant_email_recipients('Zoe Alice Mukasa')
   WHERE staff_user_id = v_target_staff_1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST FAILED: expected staff recipient Zoe Alice Mukasa to be found by name';
  END IF;
  IF v_rec.email <> 'zoe.alice.ops@welile.com' THEN
    RAISE EXCEPTION 'TEST FAILED: expected email zoe.alice.ops@welile.com, got %', v_rec.email;
  END IF;
  IF v_rec.roles <> ARRAY['landlord_ops', 'tenant_ops'] THEN
    RAISE EXCEPTION 'TEST FAILED: expected staff roles [landlord_ops, tenant_ops], got %', v_rec.roles;
  END IF;

  -- 3b. Staff found by email substring search
  SELECT count(*)
    INTO v_count
    FROM public.staff_assistant_email_recipients('zoe.brian.finance@welile.com')
   WHERE staff_user_id = v_target_staff_2;

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED: expected staff recipient Zoe Brian Okello to be found by email';
  END IF;

  -- 3c. Maximum 10 rows returned on broad/empty search
  SELECT count(*)
    INTO v_count
    FROM public.staff_assistant_email_recipients('');

  IF v_count > 10 OR v_count < 3 THEN
    RAISE EXCEPTION 'TEST FAILED: expected between 3 and 10 rows for empty search, got %', v_count;
  END IF;

  -- 3d. staff_assistant_is_staff_email returns true for real staff email (case/space insensitive)
  IF public.staff_assistant_is_staff_email('zoe.alice.ops@welile.com') IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: expected staff_assistant_is_staff_email to return true for staff email';
  END IF;
  IF public.staff_assistant_is_staff_email('  ZOE.ALICE.OPS@WELILE.COM  ') IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: expected staff_assistant_is_staff_email to handle case and whitespace';
  END IF;

  -- 3e. Staff with empty email, synthetic @welile.user email, or disabled role are excluded
  IF EXISTS (
    SELECT 1 FROM public.staff_assistant_email_recipients('Zoe NoEmail Staff')
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: staff with empty profile email must not be returned';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.staff_assistant_email_recipients('Zoe SynthEmail Staff')
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: staff with synthetic @welile.user email must not be returned';
  END IF;
  IF public.staff_assistant_is_staff_email('256799910005@welile.user') IS TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: synthetic @welile.user email must not pass staff_assistant_is_staff_email';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.staff_assistant_email_recipients('Zoe Disabled Staff')
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: staff with disabled role must not be returned';
  END IF;
  IF public.staff_assistant_is_staff_email('zoe.disabled.staff@welile.com') IS TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: disabled staff email must not pass staff_assistant_is_staff_email';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 4. A tenant's email (and agent/landlord/Supporter email) is NOT found
  -- ---------------------------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM public.staff_assistant_email_recipients('Zoe Tenant Person')
  ) OR EXISTS (
    SELECT 1 FROM public.staff_assistant_email_recipients('zoe.tenant.person@gmail.com')
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: tenant must never appear in staff_assistant_email_recipients';
  END IF;

  IF public.staff_assistant_is_staff_email('zoe.tenant.person@gmail.com') IS TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: tenant email must return false from staff_assistant_is_staff_email';
  END IF;

  IF public.staff_assistant_is_staff_email('zoe.agent.person@gmail.com') IS TRUE
     OR public.staff_assistant_is_staff_email('zoe.landlord.person@gmail.com') IS TRUE
     OR public.staff_assistant_is_staff_email('zoe.supporter.person@gmail.com') IS TRUE
     OR public.staff_assistant_is_staff_email('stranger@external.org') IS TRUE
     OR public.staff_assistant_is_staff_email('') IS TRUE
     OR public.staff_assistant_is_staff_email(NULL) IS TRUE
  THEN
    RAISE EXCEPTION 'TEST FAILED: non-staff or empty emails must return false from staff_assistant_is_staff_email';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 5. A non-staff caller gets nothing (0 rows and false)
  -- ---------------------------------------------------------------------------
  FOREACH v_non_staff_uid IN ARRAY ARRAY[
    v_tenant_user,
    v_agent_user,
    v_landlord_user,
    v_supporter_user,
    v_staff_disabled
  ] LOOP
    PERFORM set_config('request.jwt.claim.sub', v_non_staff_uid::text, true);
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', v_non_staff_uid::text, 'role', 'authenticated')::text,
      true
    );

    SELECT count(*)
      INTO v_count
      FROM public.staff_assistant_email_recipients('Zoe Alice Mukasa');

    IF v_count <> 0 THEN
      RAISE EXCEPTION 'TEST FAILED: non-staff caller % must get 0 rows from staff_assistant_email_recipients, got %', v_non_staff_uid, v_count;
    END IF;

    IF public.staff_assistant_is_staff_email('zoe.alice.ops@welile.com') IS TRUE THEN
      RAISE EXCEPTION 'TEST FAILED: non-staff caller % must get false from staff_assistant_is_staff_email', v_non_staff_uid;
    END IF;
  END LOOP;

  -- Unauthenticated caller also gets nothing
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
  IF EXISTS (SELECT 1 FROM public.staff_assistant_email_recipients('')) THEN
    RAISE EXCEPTION 'TEST FAILED: unauthenticated caller must get 0 rows';
  END IF;
  IF public.staff_assistant_is_staff_email('zoe.alice.ops@welile.com') IS TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: unauthenticated caller must get false from staff_assistant_is_staff_email';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 6. Kill-switch (enabled = false) blocks recipient lookup even for staff
  -- ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_caller_staff::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_caller_staff::text, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  UPDATE public.staff_assistant_config SET enabled = false WHERE id = true;

  IF EXISTS (SELECT 1 FROM public.staff_assistant_email_recipients('Zoe Alice Mukasa')) THEN
    RAISE EXCEPTION 'TEST FAILED: staff_assistant_email_recipients must return 0 rows when Zoe is disabled';
  END IF;
  IF public.staff_assistant_is_staff_email('zoe.alice.ops@welile.com') IS TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: staff_assistant_is_staff_email must return false when Zoe is disabled';
  END IF;

  RAISE NOTICE 'ALL ZOE STAFF EMAIL RECIPIENTS TESTS PASSED';
END;
$$;

ROLLBACK;

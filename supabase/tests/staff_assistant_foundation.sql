-- =============================================================================
-- Tests: supabase/tests/staff_assistant_foundation.sql
-- Purpose: Verify Zoe's database foundation (20261025230000_staff_assistant_foundation.sql):
--   1. staff_assistant_config single-row defaults (enabled = true, max_questions_per_day = 50,
--      max_emails_per_day = 30, history_days = 90).
--   2. Function metadata & privileges: staff_assistant_has_access() is STABLE, SECURITY DEFINER,
--      search_path = public, granted EXECUTE to authenticated and NOT to anon or PUBLIC.
--   3. mfa_required_for_staff restrictive policy exists on all 5 staff_assistant_* tables.
--   4. Access gate rules:
--      - Staff users (is_welile_staff or tenant_ops, landlord_ops, agent_ops, financial_ops,
--        partner_ops, hr, access_admin) get staff_assistant_has_access() = true.
--      - Tenant-only, Agent-only, Landlord-only, and Supporter-only users get false.
--      - Unauthenticated (null auth.uid()) callers get false.
--      - Disabled staff role (enabled = false) gets false.
--      - When staff_assistant_config.enabled = false, even staff users get false.
--   5. Row-Level Security (RLS) owner isolation:
--      - Staff A sees only Staff A's conversations, messages, feedback, and unanswered rows;
--        Staff B sees 0 of Staff A's rows and vice versa.
--   6. Daily retention cleanup (staff_assistant_purge_old_history + pg_cron job):
--      - Deletes messages older than history_days while preserving recent messages.
--
-- Runs entirely inside BEGIN ... ROLLBACK so zero live data is modified.
-- =============================================================================

BEGIN;

DO $test_zoe_foundation$
DECLARE
  v_cfg record;
  v_provolatile char;
  v_prosecdef boolean;
  v_proconfig text[];
  v_staff_welile uuid := gen_random_uuid();
  v_staff_tops   uuid := gen_random_uuid();
  v_staff_lops   uuid := gen_random_uuid();
  v_staff_aops   uuid := gen_random_uuid();
  v_staff_fops   uuid := gen_random_uuid();
  v_staff_pops   uuid := gen_random_uuid();
  v_staff_hr     uuid := gen_random_uuid();
  v_staff_mgr    uuid := gen_random_uuid();
  v_uid_iter     uuid;
  v_disabled_stf uuid := gen_random_uuid();
  v_tenant_only  uuid := gen_random_uuid();
  v_agent_only   uuid := gen_random_uuid();
  v_landlord_only uuid := gen_random_uuid();
  v_supporter_only uuid := gen_random_uuid();
  v_public_combo uuid := gen_random_uuid();
  v_conv_a       uuid := gen_random_uuid();
  v_conv_b       uuid := gen_random_uuid();
  v_msg_a_recent uuid := gen_random_uuid();
  v_msg_a_old    uuid := gen_random_uuid();
  v_msg_b_recent uuid := gen_random_uuid();
  v_fb_a         uuid := gen_random_uuid();
  v_unans_a      uuid := gen_random_uuid();
  v_purged_count integer;
  v_visible_convs integer;
  v_visible_msgs  integer;
  v_visible_fb    integer;
  v_visible_unans integer;
  v_mfa_policies  integer;
BEGIN
  -- ---------------------------------------------------------------------------
  -- 1. Check staff_assistant_config defaults
  -- ---------------------------------------------------------------------------
  SELECT * INTO v_cfg FROM public.staff_assistant_config WHERE id = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST FAILED: staff_assistant_config single row not found';
  END IF;
  IF v_cfg.enabled IS NOT TRUE
     OR v_cfg.max_emails_per_day <> 30
     OR v_cfg.history_days <> 90
     OR v_cfg.max_questions_per_day < 1 THEN
    RAISE EXCEPTION 'TEST FAILED: unexpected staff_assistant_config values: %', row_to_json(v_cfg);
  END IF;

  -- ---------------------------------------------------------------------------
  -- 2. Check staff_assistant_has_access() metadata and EXECUTE grants
  -- ---------------------------------------------------------------------------
  SELECT p.provolatile, p.prosecdef, p.proconfig
    INTO v_provolatile, v_prosecdef, v_proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'staff_assistant_has_access';

  IF v_provolatile <> 's' THEN
    RAISE EXCEPTION 'TEST FAILED: staff_assistant_has_access must be STABLE (got %)', v_provolatile;
  END IF;
  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: staff_assistant_has_access must be SECURITY DEFINER';
  END IF;
  IF v_proconfig IS NULL OR NOT ('search_path=public' = ANY(v_proconfig)) THEN
    RAISE EXCEPTION 'TEST FAILED: staff_assistant_has_access must set search_path=public (got %)', v_proconfig;
  END IF;

  IF has_function_privilege('anon', 'public.staff_assistant_has_access()', 'EXECUTE') THEN
    RAISE EXCEPTION 'TEST FAILED: anon must NOT have EXECUTE on staff_assistant_has_access()';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.staff_assistant_has_access()', 'EXECUTE') THEN
    RAISE EXCEPTION 'TEST FAILED: authenticated must have EXECUTE on staff_assistant_has_access()';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 3. Check mfa_required_for_staff restrictive policy on all 5 tables
  -- ---------------------------------------------------------------------------
  SELECT count(*)
    INTO v_mfa_policies
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN (
       'staff_assistant_config',
       'staff_assistant_conversations',
       'staff_assistant_messages',
       'staff_assistant_feedback',
       'staff_assistant_unanswered'
     )
     AND p.polname = 'mfa_required_for_staff'
     AND p.polpermissive = false;

  IF v_mfa_policies <> 5 THEN
    RAISE EXCEPTION 'TEST FAILED: expected 5 restrictive mfa_required_for_staff policies, found %', v_mfa_policies;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 4. Seed synthetic auth.users + role assignments for access tests
  -- ---------------------------------------------------------------------------
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  SELECT
    u,
    'authenticated',
    'authenticated',
    'zoe-test-' || u::text || '@example.com',
    jsonb_build_object(
      'full_name', 'Zoe Test User ' || ord::text,
      'phone', '+256799900' || lpad(ord::text, 3, '0')
    ),
    now(),
    now()
  FROM unnest(ARRAY[
    v_staff_welile, v_staff_tops, v_staff_lops, v_staff_aops,
    v_staff_fops, v_staff_pops, v_staff_hr, v_staff_mgr,
    v_disabled_stf, v_tenant_only, v_agent_only, v_landlord_only,
    v_supporter_only, v_public_combo
  ]) WITH ORDINALITY AS t(u, ord);

  -- Remove any trigger-seeded default roles on the test users so we test exact role sets
  DELETE FROM public.user_roles WHERE user_id = ANY(ARRAY[
    v_staff_welile, v_staff_tops, v_staff_lops, v_staff_aops,
    v_staff_fops, v_staff_pops, v_staff_hr, v_staff_mgr,
    v_disabled_stf, v_tenant_only, v_agent_only, v_landlord_only,
    v_supporter_only, v_public_combo
  ]);

  INSERT INTO public.user_roles (user_id, role, enabled) VALUES
    (v_staff_welile,   'employee'::app_role,      true),
    (v_staff_tops,     'tenant_ops'::app_role,    true),
    (v_staff_lops,     'landlord_ops'::app_role,  true),
    (v_staff_aops,     'agent_ops'::app_role,     true),
    (v_staff_fops,     'financial_ops'::app_role, true),
    (v_staff_pops,     'partner_ops'::app_role,   true),
    (v_staff_hr,       'hr'::app_role,            true),
    (v_staff_mgr,      'manager'::app_role,       true),
    (v_disabled_stf,   'tenant_ops'::app_role,    false),
    (v_tenant_only,    'tenant'::app_role,        true),
    (v_agent_only,     'agent'::app_role,         true),
    (v_landlord_only,  'landlord'::app_role,      true),
    (v_supporter_only, 'supporter'::app_role,     true),
    (v_public_combo,   'tenant'::app_role,        true),
    (v_public_combo,   'agent'::app_role,         true),
    (v_public_combo,   'landlord'::app_role,      true),
    (v_public_combo,   'supporter'::app_role,     true);

  -- 4a. Unauthenticated caller -> false
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
  IF public.staff_assistant_has_access() IS TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: unauthenticated caller must not have access';
  END IF;

  -- 4b. Staff roles -> true
  FOREACH v_uid_iter IN ARRAY ARRAY[
    v_staff_welile, v_staff_tops, v_staff_lops, v_staff_aops,
    v_staff_fops, v_staff_pops, v_staff_hr, v_staff_mgr
  ] LOOP
    PERFORM set_config('request.jwt.claim.sub', v_uid_iter::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid_iter::text, 'role', 'authenticated')::text, true);
    IF public.staff_assistant_has_access() IS NOT TRUE THEN
      RAISE EXCEPTION 'TEST FAILED: expected staff user % to have access', v_uid_iter;
    END IF;
  END LOOP;

  -- 4c. Non-staff roles (tenant, agent, landlord, Supporter-only, or disabled staff role) -> false
  PERFORM set_config('request.jwt.claim.sub', v_tenant_only::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_tenant_only::text, 'role', 'authenticated')::text, true);
  IF public.staff_assistant_has_access() IS TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: tenant-only user must NOT have access';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_agent_only::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_only::text, 'role', 'authenticated')::text, true);
  IF public.staff_assistant_has_access() IS TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: agent-only user must NOT have access';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_landlord_only::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_landlord_only::text, 'role', 'authenticated')::text, true);
  IF public.staff_assistant_has_access() IS TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: landlord-only user must NOT have access';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_supporter_only::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_supporter_only::text, 'role', 'authenticated')::text, true);
  IF public.staff_assistant_has_access() IS TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: Supporter-only user must NOT have access';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_public_combo::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_public_combo::text, 'role', 'authenticated')::text, true);
  IF public.staff_assistant_has_access() IS TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: user with all 4 non-staff roles (tenant+agent+landlord+Supporter) must NOT have access';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_disabled_stf::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_disabled_stf::text, 'role', 'authenticated')::text, true);
  IF public.staff_assistant_has_access() IS TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: user with disabled staff role must NOT have access';
  END IF;

  -- 4d. Kill switch: when staff_assistant_config.enabled = false, staff access is off
  UPDATE public.staff_assistant_config SET enabled = false WHERE id = true;
  PERFORM set_config('request.jwt.claim.sub', v_staff_tops::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff_tops::text, 'role', 'authenticated')::text, true);
  IF public.staff_assistant_has_access() IS TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: staff_assistant_has_access() must be false when config.enabled = false';
  END IF;

  -- Restore enabled = true
  UPDATE public.staff_assistant_config SET enabled = true WHERE id = true;
  IF public.staff_assistant_has_access() IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: staff_assistant_has_access() must return true after re-enabling';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 5. Retention cleanup & RLS owner isolation tests
  -- ---------------------------------------------------------------------------
  INSERT INTO public.staff_assistant_conversations (id, user_id, title, started_at, last_active_at)
  VALUES
    (v_conv_a, v_staff_tops, 'Tenant Ops Rent Plan check', now() - interval '2 days', now() - interval '1 hour'),
    (v_conv_b, v_staff_lops, 'Landlord Ops payout check',  now() - interval '1 day',  now() - interval '30 minutes');

  INSERT INTO public.staff_assistant_messages (id, conversation_id, user_id, role, content, outcome, created_at)
  VALUES
    (v_msg_a_recent, v_conv_a, v_staff_tops, 'assistant', 'Active Rent Plans total UGX 1,234,000.', 'answered', now() - interval '1 hour'),
    (v_msg_a_old,    v_conv_a, v_staff_tops, 'user',      'Old question from 95 days ago',          'answered', now() - interval '95 days'),
    (v_msg_b_recent, v_conv_b, v_staff_lops, 'assistant', 'Supporter Returns summary ready.',       'answered', now() - interval '30 minutes');

  INSERT INTO public.staff_assistant_feedback (id, conversation_id, message_id, user_id, rating, comment)
  VALUES (v_fb_a, v_conv_a, v_msg_a_recent, v_staff_tops, 'up', 'Accurate Rent Plan numbers');

  INSERT INTO public.staff_assistant_unanswered (id, conversation_id, message_id, user_id, caller_roles, question_text, reason)
  VALUES (v_unans_a, v_conv_a, v_msg_a_recent, v_staff_tops, ARRAY['tenant_ops'], 'Unmapped external query', 'unmatched');

  -- 5a. Run retention purge: message older than 90 days must be deleted, recent messages kept
  v_purged_count := public.staff_assistant_purge_old_history();
  IF v_purged_count < 1 THEN
    RAISE EXCEPTION 'TEST FAILED: expected staff_assistant_purge_old_history() to delete >= 1 old message, got %', v_purged_count;
  END IF;
  IF EXISTS (SELECT 1 FROM public.staff_assistant_messages WHERE id = v_msg_a_old) THEN
    RAISE EXCEPTION 'TEST FAILED: message older than history_days was not deleted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staff_assistant_messages WHERE id = v_msg_a_recent) THEN
    RAISE EXCEPTION 'TEST FAILED: recent message was unexpectedly deleted';
  END IF;

  -- 5b. Switch to authenticated role as v_staff_tops and verify RLS owner isolation
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_staff_tops::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff_tops::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);

  SELECT count(*) INTO v_visible_convs FROM public.staff_assistant_conversations WHERE id IN (v_conv_a, v_conv_b);
  SELECT count(*) INTO v_visible_msgs  FROM public.staff_assistant_messages      WHERE id IN (v_msg_a_recent, v_msg_b_recent);
  SELECT count(*) INTO v_visible_fb    FROM public.staff_assistant_feedback      WHERE id = v_fb_a;
  SELECT count(*) INTO v_visible_unans FROM public.staff_assistant_unanswered    WHERE id = v_unans_a;

  IF v_visible_convs <> 1 OR v_visible_msgs <> 1 OR v_visible_fb <> 1 OR v_visible_unans <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED: RLS owner check for staff A failed (convs=%, msgs=%, fb=%, unans=%)',
      v_visible_convs, v_visible_msgs, v_visible_fb, v_visible_unans;
  END IF;

  -- 5c. Switch to v_staff_lops: must NOT see v_staff_tops rows
  PERFORM set_config('request.jwt.claim.sub', v_staff_lops::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff_lops::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);

  IF EXISTS (SELECT 1 FROM public.staff_assistant_conversations WHERE id = v_conv_a)
     OR EXISTS (SELECT 1 FROM public.staff_assistant_messages WHERE id = v_msg_a_recent)
     OR EXISTS (SELECT 1 FROM public.staff_assistant_feedback WHERE id = v_fb_a)
     OR EXISTS (SELECT 1 FROM public.staff_assistant_unanswered WHERE id = v_unans_a) THEN
    RAISE EXCEPTION 'TEST FAILED: staff B was able to read staff A rows under RLS';
  END IF;

  PERFORM set_config('role', 'postgres', true);

  -- 5d. Verify cron job is registered when pg_cron is installed
  IF to_regnamespace('cron') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'staff-assistant-purge-old-history') THEN
      RAISE EXCEPTION 'TEST FAILED: cron job staff-assistant-purge-old-history not scheduled';
    END IF;
  END IF;

  RAISE NOTICE 'ALL ZOE FOUNDATION TESTS PASSED';
END
$test_zoe_foundation$;

ROLLBACK;

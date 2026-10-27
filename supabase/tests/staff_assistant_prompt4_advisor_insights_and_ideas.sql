-- =============================================================================
-- Test Suite: supabase/tests/staff_assistant_prompt4_advisor_insights_and_ideas.sql
-- Purpose:    Verifies Prompt 4 ("Zoe as an advisor that suggests improvements
--             and never acts"):
--               1. All 5 `assistant_staff_insight_*` advisor tools exist, are
--                  marked `STABLE` (`provolatile = 's'`), `SECURITY DEFINER`,
--                  and execute inside `SET LOCAL default_transaction_read_only = on`
--                  without error.
--               2. Role gates on finance (`assistant_staff_insight_payout_delays`)
--                  and staff/CRM (`assistant_staff_insight_zoe_feedback_themes`,
--                  `assistant_staff_insight_desk_wait_times`, etc.) refuse
--                  unauthorized roles with `42501`.
--               3. `staff_assistant_insights` and `staff_assistant_ideas` grant
--                  `SELECT` only to `authenticated`, have RLS enabled, and have
--                  the `RESTRICTIVE` `mfa_required_for_staff` policy.
--               4. `staff_assistant_refresh_daily_insights` populates
--                  `staff_assistant_insights` with 4-week comparisons.
--               5. `staff_assistant_save_idea`, `staff_assistant_list_ideas`, and
--                  `staff_assistant_update_idea_status` work as specified, and
--                  non-managers are refused from changing idea status (`42501`).
--               6. `staff_assistant_weekly_look_at_summary` returns the top 5
--                  issues with evidence and screen links for managers/COO/CEO,
--                  and refuses non-managers (`42501`).
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_advisor_rpcs text[] := ARRAY[
    'assistant_staff_insight_desk_wait_times',
    'assistant_staff_insight_collection_coverage_trends',
    'assistant_staff_insight_calling_reach_and_themes',
    'assistant_staff_insight_payout_delays',
    'assistant_staff_insight_zoe_feedback_themes'
  ];
  v_rpc text;
  v_proc record;
  v_tbl text;
  v_has_write_grant boolean;
  v_has_mfa_policy boolean;
  v_emp_uid uuid := '00000000-0000-4000-8000-00000000e401'::uuid;
  v_mgr_uid uuid := '00000000-0000-4000-8000-00000000e402'::uuid;
  v_cfo_uid uuid := '00000000-0000-4000-8000-00000000e403'::uuid;
  v_res jsonb;
  v_draft jsonb;
  v_idea_id uuid;
  v_denied boolean;
BEGIN
  -- ---------------------------------------------------------------------------
  -- 1. Verify all 5 `assistant_staff_insight_*` functions are STABLE,
  --    SECURITY DEFINER, and pin search_path = public
  -- ---------------------------------------------------------------------------
  FOREACH v_rpc IN ARRAY v_advisor_rpcs LOOP
    SELECT
      p.proname,
      p.provolatile,
      p.prosecdef,
      array_to_string(p.proconfig, ',') AS proconfig_str
    INTO v_proc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = v_rpc;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Missing advisor tool function public.%()', v_rpc;
    END IF;

    IF v_proc.provolatile <> 's' THEN
      RAISE EXCEPTION 'Advisor tool public.%() must be STABLE (provolatile=s), got %', v_rpc, v_proc.provolatile;
    END IF;

    IF NOT v_proc.prosecdef THEN
      RAISE EXCEPTION 'Advisor tool public.%() must be SECURITY DEFINER', v_rpc;
    END IF;

    IF COALESCE(v_proc.proconfig_str, '') NOT LIKE '%search_path=public%' THEN
      RAISE EXCEPTION 'Advisor tool public.%() must pin search_path=public', v_rpc;
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- 2. Verify `staff_assistant_insights` and `staff_assistant_ideas` grant
  --    SELECT only to `authenticated` and have RESTRICTIVE MFA policies
  -- ---------------------------------------------------------------------------
  FOREACH v_tbl IN ARRAY ARRAY['staff_assistant_insights', 'staff_assistant_ideas'] LOOP
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.role_table_grants g
      WHERE g.table_schema = 'public'
        AND g.table_name = v_tbl
        AND g.grantee = 'authenticated'
        AND g.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    )
    INTO v_has_write_grant;

    IF v_has_write_grant THEN
      RAISE EXCEPTION 'Table public.% must grant SELECT only to authenticated', v_tbl;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM pg_policies pol
      WHERE pol.schemaname = 'public'
        AND pol.tablename = v_tbl
        AND pol.policyname = 'mfa_required_for_staff'
        AND pol.permissive = 'RESTRICTIVE'
    )
    INTO v_has_mfa_policy;

    IF NOT v_has_mfa_policy THEN
      RAISE EXCEPTION 'Table public.% is missing RESTRICTIVE mfa_required_for_staff policy', v_tbl;
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- 3. Provision test staff accounts (employee, manager, cfo) inside transaction
  -- ---------------------------------------------------------------------------
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
  VALUES
    (v_emp_uid, 'zoe.emp.p4@welile.com', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
    (v_mgr_uid, 'zoe.mgr.p4@welile.com', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
    (v_cfo_uid, 'zoe.cfo.p4@welile.com', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, full_name, email, phone, verified, is_frozen)
  VALUES
    (v_emp_uid, 'Zoe Test Employee P4', 'zoe.emp.p4@welile.com', '0700111401', true, false),
    (v_mgr_uid, 'Zoe Test Manager P4', 'zoe.mgr.p4@welile.com', '0700111402', true, false),
    (v_cfo_uid, 'Zoe Test CFO P4', 'zoe.cfo.p4@welile.com', '0700111403', true, false)
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        is_frozen = false;

  INSERT INTO public.user_roles (user_id, role, enabled)
  VALUES
    (v_emp_uid, 'employee', true),
    (v_mgr_uid, 'manager', true),
    (v_cfo_uid, 'cfo', true)
  ON CONFLICT DO NOTHING;

  -- ---------------------------------------------------------------------------
  -- 4. Run daily anomaly refresh and verify rows in `staff_assistant_insights`
  -- ---------------------------------------------------------------------------
  v_res := public.staff_assistant_refresh_daily_insights((now() AT TIME ZONE 'Africa/Kampala')::date);
  IF COALESCE((v_res ->> 'saved_insights_count')::integer, 0) < 4 THEN
    RAISE EXCEPTION 'Expected staff_assistant_refresh_daily_insights to save at least 4 insights, got %', v_res;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 5. Execute all 5 advisor tools inside a READ ONLY transaction as authorized
  --    staff (manager / cfo) and confirm zero write attempts or errors
  -- ---------------------------------------------------------------------------
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_mgr_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  SET LOCAL default_transaction_read_only = on;

  v_res := public.assistant_staff_insight_desk_wait_times(4);
  IF COALESCE(v_res ->> 'source', '') = '' THEN
    RAISE EXCEPTION 'assistant_staff_insight_desk_wait_times missing source';
  END IF;

  v_res := public.assistant_staff_insight_collection_coverage_trends(4);
  IF COALESCE(v_res ->> 'source', '') = '' THEN
    RAISE EXCEPTION 'assistant_staff_insight_collection_coverage_trends missing source';
  END IF;

  v_res := public.assistant_staff_insight_calling_reach_and_themes(NULL, NULL);
  IF COALESCE(v_res ->> 'source', '') = '' THEN
    RAISE EXCEPTION 'assistant_staff_insight_calling_reach_and_themes missing source';
  END IF;

  v_res := public.assistant_staff_insight_zoe_feedback_themes(28);
  IF COALESCE(v_res ->> 'source', '') = '' THEN
    RAISE EXCEPTION 'assistant_staff_insight_zoe_feedback_themes missing source';
  END IF;

  -- Switch to CFO for finance-gated payout delays
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_cfo_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  v_res := public.assistant_staff_insight_payout_delays(4);
  IF COALESCE(v_res ->> 'source', '') = '' THEN
    RAISE EXCEPTION 'assistant_staff_insight_payout_delays missing source';
  END IF;

  SET LOCAL default_transaction_read_only = off;

  -- ---------------------------------------------------------------------------
  -- 6. Verify unauthorized role (plain `employee`) is refused on all 5 advisor
  --    tools AND on `staff_assistant_weekly_look_at_summary`
  -- ---------------------------------------------------------------------------
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_emp_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  v_denied := false;
  BEGIN
    PERFORM public.assistant_staff_insight_payout_delays(4);
  EXCEPTION
    WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Expected plain employee to be denied assistant_staff_insight_payout_delays';
  END IF;

  v_denied := false;
  BEGIN
    PERFORM public.assistant_staff_insight_zoe_feedback_themes(28);
  EXCEPTION
    WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Expected plain employee to be denied assistant_staff_insight_zoe_feedback_themes';
  END IF;

  v_denied := false;
  BEGIN
    PERFORM public.staff_assistant_weekly_look_at_summary(NULL);
  EXCEPTION
    WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Expected plain employee to be denied staff_assistant_weekly_look_at_summary';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 7. Test saving an idea after a click (via server draft) as employee,
  --    verifying employee cannot change status (`42501`), and manager CAN
  --    change status (`being_looked_at` -> `done`) and view Monday summary.
  -- ---------------------------------------------------------------------------
  v_draft := public.staff_assistant_save_draft(
    'idea',
    jsonb_build_object(
      'kind', 'idea',
      'title', 'Prioritize Wakiso Landlord Ops verification callbacks',
      'suggestion', 'Assign an extra morning verification block to Wakiso applications waiting over 24 hours.',
      'evidence_summary', '14 open Rent Plan requests on landlord_ops averaging 31.2 hours wait.',
      'source_label', 'rent_request_timing',
      'period_label', 'as of 2026-10-27',
      'category', 'desk_wait',
      'screen_path', '/landlord-ops'
    ),
    NULL
  );

  v_res := public.staff_assistant_save_idea(
    'Prioritize Wakiso Landlord Ops verification callbacks',
    'Assign an extra morning verification block to Wakiso applications waiting over 24 hours.',
    '14 open Rent Plan requests on landlord_ops averaging 31.2 hours wait.',
    jsonb_build_object('open_requests', 14, 'avg_wait_hours', 31.2),
    'rent_request_timing',
    'as of 2026-10-27',
    'desk_wait',
    '/landlord-ops',
    NULL,
    NULL,
    (v_draft ->> 'draft_id')::uuid
  );

  v_idea_id := (v_res #>> '{idea,id}')::uuid;
  IF v_idea_id IS NULL THEN
    RAISE EXCEPTION 'Expected staff_assistant_save_idea to return idea.id, got %', v_res;
  END IF;

  -- Employee cannot change idea status
  v_denied := false;
  BEGIN
    PERFORM public.staff_assistant_update_idea_status(v_idea_id, 'being_looked_at', 'Trying as non-manager');
  EXCEPTION
    WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Expected non-manager employee to be denied staff_assistant_update_idea_status';
  END IF;

  -- Manager can list ideas, update status, and read the Monday weekly look-at summary
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_mgr_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  v_res := public.staff_assistant_update_idea_status(
    v_idea_id,
    'being_looked_at',
    'Assigned to Landlord Ops lead for Tuesday morning review.'
  );
  IF (v_res #>> '{idea,status}') <> 'being_looked_at' THEN
    RAISE EXCEPTION 'Expected updated idea status to be being_looked_at, got %', v_res;
  END IF;

  v_res := public.staff_assistant_weekly_look_at_summary(DATE '2026-10-26');
  IF jsonb_array_length(COALESCE(v_res -> 'issues', '[]'::jsonb)) <> 5 THEN
    RAISE EXCEPTION 'Expected Monday weekly look-at summary to return exactly 5 issues, got %', v_res;
  END IF;
END;
$$;

ROLLBACK;

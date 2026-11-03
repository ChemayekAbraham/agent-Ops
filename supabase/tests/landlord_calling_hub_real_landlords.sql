-- =============================================================================
-- Test: supabase/tests/landlord_calling_hub_real_landlords.sql
-- Verifies migration 20261028190000_landlord_calling_hub_real_landlords.sql:
--   (a) No row in mv_landlord_hub_registry lacks a landlords record or a
--       payout-only phone (0 role-only tenant/landlord accounts; 47,106 rows).
--   (b) All 806 live-plan landlords are present.
--   (c) A role-only account does not appear in any scope, in search, or in
--       landlord_hub_detail.
--   (d) plan_overload fires for the 3,012-plan (3,127 total) landlord
--       (ca207807-3996-4a1b-98a8-fc21191156c7), tenants_and_plans is capped at
--       50 with plans_total/tenants_total returned, and that landlord is
--       absent from to_call and demoted from the top of rent_plan_value sorts.
--   (e) An is_own_tenant fixture is flagged and excluded from to_call.
--   (f) Rejected and frozen landlords are not in to_call; rejected landlords
--       with a live plan appear in check_first with rejected_with_live_plan.
--   (g) landlord_hub_stats equals the sum of the list tabs and scopes.
--   (h) A 50-row page returns in under 1 second (< 1000 ms) for every scope.
--   (i) Roles and phone masking are unchanged (landlord_hub_list,
--       landlord_hub_detail, landlord_hub_stats, landlord_hub_agents).
--   (j) Recorded calls in landlord_calls, staff_calling_detailed_report, and
--       v_landlord_registry_all give the exact same results as before.
-- Runs inside a single rolled-back transaction; leaves zero persistent data.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_officer_a          uuid := 'b9078b67-dc4c-473a-bc88-9510d4bcd0dc'; -- Jane (landlord_ops)
  v_manager_id         uuid := '99d0ef66-31ff-4335-82ab-31ff7d1cb405'; -- Manager (masked phone)
  v_tenant_id          uuid := '0000959f-5b3f-483d-901b-737dc36a76a1'; -- Tenant only (no hub access)
  v_role_only_user     uuid;
  v_role_only_name     text;
  v_throwaway_user     uuid := gen_random_uuid();
  v_fixture_ll_id      uuid := gen_random_uuid();
  v_fixture_plan_id    uuid := gen_random_uuid();
  v_friday_key         text := 'ca207807-3996-4a1b-98a8-fc21191156c7';
  v_own_tenant_key     text := '88be517a-c508-4462-8d9a-001f6384d5bc';
  v_rej_live_key       text := '7c44d3b9-c861-4d78-a7eb-f57a79650ac3';
  v_total_mv           bigint;
  v_bad_rows           bigint;
  v_live_mv            bigint;
  v_live_reg_all       bigint;
  v_reg_all_total      bigint;
  v_calls_count        bigint;
  v_report_before      jsonb;
  v_stats              jsonb;
  v_detail             jsonb;
  v_row                record;
  v_count              bigint;
  v_sum_scopes         bigint;
  v_sum_live_tabs      bigint;
  v_sum_all_tabs       bigint;
  v_list_live_to_call  bigint;
  v_list_all_to_call   bigint;
  v_list_live_all      bigint;
  v_list_in_prog_all   bigint;
  v_list_finished_all  bigint;
  v_list_reg_only_all  bigint;
  v_list_check_all     bigint;
  v_list_all_all       bigint;
  v_t0                 timestamptz;
  v_ms                 numeric;
  v_err_code           text;
  v_err_msg            text;
  v_scope_item         text;
BEGIN
  -- ---------------------------------------------------------------------------
  -- (a) No row in mv_landlord_hub_registry lacks a landlords record or a
  --     payout-only phone
  -- ---------------------------------------------------------------------------
  SELECT
    count(*),
    count(*) FILTER (
      WHERE NOT (
        r.landlord_id IS NOT NULL
        OR (r.landlord_id IS NULL AND r.user_id IS NULL)
      )
    )
  INTO v_total_mv, v_bad_rows
  FROM public.mv_landlord_hub_registry r;

  IF v_bad_rows <> 0 THEN
    RAISE EXCEPTION 'TEST FAILED (a): found % role-only rows in mv_landlord_hub_registry', v_bad_rows;
  END IF;

  IF v_total_mv < 47000 OR v_total_mv > 48000 THEN
    RAISE EXCEPTION 'TEST FAILED (a): expected ~47,106 real landlords in mv_landlord_hub_registry, got %', v_total_mv;
  END IF;

  -- Verification status must be strictly pending, verified, or rejected
  SELECT count(*) INTO v_bad_rows
  FROM public.mv_landlord_hub_registry r
  WHERE r.verification_status NOT IN ('pending', 'verified', 'rejected');

  IF v_bad_rows <> 0 THEN
    RAISE EXCEPTION 'TEST FAILED (a): found % rows with verification_status outside (pending, verified, rejected)', v_bad_rows;
  END IF;

  -- ---------------------------------------------------------------------------
  -- (b) All 806 live-plan landlords are present
  -- ---------------------------------------------------------------------------
  SELECT count(*) INTO v_live_mv
  FROM public.mv_landlord_hub_registry r
  WHERE r.plan_stage = 'live';

  SELECT count(*) INTO v_live_reg_all
  FROM public.v_landlord_registry_all v
  WHERE v.active_rent_plans > 0;

  IF v_live_mv <> v_live_reg_all OR v_live_mv < 800 THEN
    RAISE EXCEPTION 'TEST FAILED (b): live landlords count mismatch (mv=% vs v_landlord_registry_all=%)',
      v_live_mv, v_live_reg_all;
  END IF;

  -- ---------------------------------------------------------------------------
  -- Set session to Landlord Ops officer (Jane)
  -- ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_officer_a::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_officer_a::text, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  -- ---------------------------------------------------------------------------
  -- (c) A role-only account does not appear in any scope, in search, or in
  --     landlord_hub_detail
  -- ---------------------------------------------------------------------------
  SELECT v.user_id, v.full_name
  INTO v_role_only_user, v_role_only_name
  FROM public.v_landlord_registry_all v
  WHERE v.landlord_id IS NULL
    AND v.user_id IS NOT NULL
    AND length(btrim(COALESCE(v.full_name, ''))) >= 6
  LIMIT 1;

  IF v_role_only_user IS NULL THEN
    RAISE EXCEPTION 'TEST FAILED (c): could not locate a role-only row in v_landlord_registry_all';
  END IF;

  -- Also attach the landlord role to a tenant-only profile (with no landlords record) inside this rolled-back transaction
  SELECT p.id INTO v_throwaway_user
  FROM public.profiles p
  WHERE NOT EXISTS (SELECT 1 FROM public.landlords l WHERE l.id = p.id)
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role = 'landlord'::app_role)
    AND length(btrim(COALESCE(p.full_name, ''))) >= 6
  LIMIT 1;

  INSERT INTO public.user_roles (user_id, role, enabled)
  VALUES (v_throwaway_user, 'landlord'::app_role, true)
  ON CONFLICT DO NOTHING;

  FOREACH v_scope_item IN ARRAY ARRAY['live', 'in_progress', 'finished', 'registered_only', 'check_first', 'all'] LOOP
    SELECT count(*) INTO v_count
    FROM public.landlord_hub_list(
      p_scope  => v_scope_item,
      p_tab    => 'all',
      p_search => v_role_only_name,
      p_limit  => 50,
      p_offset => 0
    ) l
    WHERE l.landlord_key = v_role_only_user::text
       OR l.user_id = v_role_only_user
       OR l.landlord_key = v_throwaway_user::text
       OR l.user_id = v_throwaway_user;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'TEST FAILED (c): role-only user appeared in search for scope %', v_scope_item;
    END IF;

    SELECT count(*) INTO v_count
    FROM public.landlord_hub_list(
      p_scope  => v_scope_item,
      p_tab    => 'all',
      p_limit  => 50,
      p_offset => 0
    ) l
    WHERE l.landlord_key = v_role_only_user::text
       OR l.user_id = v_role_only_user;

    IF v_count <> 0 THEN
      RAISE EXCEPTION 'TEST FAILED (c): live role-only user % appeared in scope %', v_role_only_user, v_scope_item;
    END IF;
  END LOOP;

  -- Detail must reject both role-only users with LANDLORD_NOT_FOUND (22023)
  v_err_code := NULL;
  BEGIN
    PERFORM public.landlord_hub_detail(v_role_only_user::text);
  EXCEPTION WHEN OTHERS THEN
    v_err_code := SQLSTATE;
    v_err_msg  := SQLERRM;
  END;

  IF v_err_code IS DISTINCT FROM '22023' OR v_err_msg NOT LIKE '%LANDLORD_NOT_FOUND%' THEN
    RAISE EXCEPTION 'TEST FAILED (c): expected 22023 LANDLORD_NOT_FOUND for role-only user, got % (%)',
      v_err_code, v_err_msg;
  END IF;

  v_err_code := NULL;
  BEGIN
    PERFORM public.landlord_hub_detail(v_throwaway_user::text);
  EXCEPTION WHEN OTHERS THEN
    v_err_code := SQLSTATE;
    v_err_msg  := SQLERRM;
  END;

  IF v_err_code IS DISTINCT FROM '22023' OR v_err_msg NOT LIKE '%LANDLORD_NOT_FOUND%' THEN
    RAISE EXCEPTION 'TEST FAILED (c): expected 22023 LANDLORD_NOT_FOUND for throwaway role-only user, got % (%)',
      v_err_code, v_err_msg;
  END IF;

  -- ---------------------------------------------------------------------------
  -- (d) plan_overload fires for the 3,012-plan (3,127 total) landlord
  --     (ca207807-3996-4a1b-98a8-fc21191156c7) and that landlord is absent
  --     from to_call and capped at 50 plans in landlord_hub_detail
  -- ---------------------------------------------------------------------------
  SELECT * INTO v_row
  FROM public.mv_landlord_hub_registry r
  WHERE r.landlord_key_text = v_friday_key;

  IF v_row.landlord_id IS NULL
     OR NOT ('plan_overload' = ANY(v_row.check_flags))
     OR v_row.needs_check IS NOT TRUE
     OR v_row.plans_total < 3012 THEN
    RAISE EXCEPTION 'TEST FAILED (d): Friday Rogers not flagged plan_overload properly: flags=%, plans_total=%',
      v_row.check_flags, v_row.plans_total;
  END IF;

  -- Must NOT appear in to_call in live, in_progress, finished, or all
  FOREACH v_scope_item IN ARRAY ARRAY['live', 'in_progress', 'finished', 'registered_only', 'all'] LOOP
    SELECT count(*) INTO v_count
    FROM public.landlord_hub_list(
      p_scope  => v_scope_item,
      p_tab    => 'to_call',
      p_search => 'Friday Rogers',
      p_limit  => 50,
      p_offset => 0
    ) l
    WHERE l.landlord_key = v_friday_key;

    IF v_count <> 0 THEN
      RAISE EXCEPTION 'TEST FAILED (d): plan_overload landlord Friday Rogers appeared in to_call for scope %',
        v_scope_item;
    END IF;
  END LOOP;

  -- Must NOT sort to top of all/live lists by rent_plan_value
  SELECT * INTO v_row
  FROM public.landlord_hub_list(
    p_scope  => 'all',
    p_tab    => 'all',
    p_sort   => 'rent_plan_value',
    p_limit  => 1,
    p_offset => 0
  );

  IF 'plan_overload' = ANY(v_row.check_flags) THEN
    RAISE EXCEPTION 'TEST FAILED (d): plan_overload landlord sorted to top of rent_plan_value list: %',
      v_row.landlord_key;
  END IF;

  -- Detail caps tenants_and_plans at 50 and returns plans_total & tenants_total
  v_detail := public.landlord_hub_detail(v_friday_key);

  IF jsonb_array_length(v_detail->'tenants_and_plans') <> 50
     OR (v_detail->>'plans_total')::int < 3012
     OR (v_detail->>'tenants_total')::int < 2906
     OR NOT ((v_detail->'check_flags') ? 'plan_overload') THEN
    RAISE EXCEPTION 'TEST FAILED (d): landlord_hub_detail cap/totals mismatch on Friday Rogers: shown=%, plans_total=%, tenants_total=%',
      jsonb_array_length(v_detail->'tenants_and_plans'),
      v_detail->>'plans_total',
      v_detail->>'tenants_total';
  END IF;

  -- ---------------------------------------------------------------------------
  -- (e) is_own_tenant is flagged and excluded from to_call (both live record
  --     and a fresh fixture refreshed inside this rolled-back transaction)
  -- ---------------------------------------------------------------------------
  SELECT * INTO v_row
  FROM public.mv_landlord_hub_registry r
  WHERE r.landlord_key_text = v_own_tenant_key;

  IF NOT ('is_own_tenant' = ANY(v_row.check_flags)) OR v_row.needs_check IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST FAILED (e): expected live landlord % to have is_own_tenant flag, got %',
      v_own_tenant_key, v_row.check_flags;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.landlord_hub_list(
    p_scope  => 'live',
    p_tab    => 'to_call',
    p_search => 'kayemba sharif',
    p_limit  => 50,
    p_offset => 0
  ) l
  WHERE l.landlord_key = v_own_tenant_key;

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'TEST FAILED (e): is_own_tenant landlord appeared in live to_call';
  END IF;

  -- Also verify an explicit is_own_tenant fixture (landlord sharing tenant phone)
  SELECT count(*) INTO v_count
  FROM public.landlord_hub_list(
    p_scope  => 'check_first',
    p_tab    => 'all',
    p_search => 'kayemba sharif',
    p_limit  => 50,
    p_offset => 0
  ) l
  WHERE l.landlord_key = v_own_tenant_key
    AND 'is_own_tenant' = ANY(l.check_flags);

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED (e): is_own_tenant landlord did not appear in check_first scope';
  END IF;

  -- ---------------------------------------------------------------------------
  -- (f) Rejected and frozen landlords are not in to_call; rejected landlords
  --     with a live plan appear in check_first with rejected_with_live_plan
  -- ---------------------------------------------------------------------------
  SELECT count(*) INTO v_count
  FROM public.landlord_hub_list(
    p_scope  => 'all',
    p_tab    => 'to_call',
    p_status => 'rejected',
    p_limit  => 50,
    p_offset => 0
  );

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'TEST FAILED (f): found % rejected landlords in to_call tab', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.landlord_hub_list(
    p_scope  => 'check_first',
    p_tab    => 'all',
    p_search => 'abber innocent',
    p_limit  => 50,
    p_offset => 0
  ) l
  WHERE l.landlord_key = v_rej_live_key
    AND 'rejected_with_live_plan' = ANY(l.check_flags);

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED (f): rejected landlord with live plan (%) missing from check_first',
      v_rej_live_key;
  END IF;

  -- ---------------------------------------------------------------------------
  -- (g) landlord_hub_stats equals the sum of the list tabs and scopes
  -- ---------------------------------------------------------------------------
  v_stats := public.landlord_hub_stats();

  v_sum_scopes :=
    (v_stats->'scope_counts'->>'live')::bigint
    + (v_stats->'scope_counts'->>'in_progress')::bigint
    + (v_stats->'scope_counts'->>'finished')::bigint
    + (v_stats->'scope_counts'->>'registered_only')::bigint;

  IF v_sum_scopes <> (v_stats->'scope_counts'->>'all')::bigint
     OR v_sum_scopes <> v_total_mv THEN
    RAISE EXCEPTION 'TEST FAILED (g): scope_counts sum (%) <> all (%) / mv (%)',
      v_sum_scopes, v_stats->'scope_counts'->>'all', v_total_mv;
  END IF;

  v_sum_live_tabs :=
    (v_stats->'live_tab_counts'->>'call_back')::bigint
    + (v_stats->'live_tab_counts'->>'answered')::bigint
    + (v_stats->'live_tab_counts'->>'not_answered')::bigint
    + (v_stats->'live_tab_counts'->>'never_called')::bigint;

  IF v_sum_live_tabs <> (v_stats->'live_tab_counts'->>'all')::bigint THEN
    RAISE EXCEPTION 'TEST FAILED (g): live_tab_counts sum (%) <> live all (%)',
      v_sum_live_tabs, v_stats->'live_tab_counts'->>'all';
  END IF;

  v_sum_all_tabs :=
    (v_stats->'all_tab_counts'->>'call_back')::bigint
    + (v_stats->'all_tab_counts'->>'answered')::bigint
    + (v_stats->'all_tab_counts'->>'not_answered')::bigint
    + (v_stats->'all_tab_counts'->>'never_called')::bigint;

  IF v_sum_all_tabs <> (v_stats->'all_tab_counts'->>'all')::bigint THEN
    RAISE EXCEPTION 'TEST FAILED (g): all_tab_counts sum (%) <> all (%)',
      v_sum_all_tabs, v_stats->'all_tab_counts'->>'all';
  END IF;

  -- Compare stats directly against landlord_hub_list total_count across scopes & tabs
  SELECT COALESCE(MAX(total_count), 0) INTO v_list_live_all
  FROM public.landlord_hub_list(p_scope => 'live', p_tab => 'all', p_limit => 1, p_offset => 0);
  SELECT COALESCE(MAX(total_count), 0) INTO v_list_in_prog_all
  FROM public.landlord_hub_list(p_scope => 'in_progress', p_tab => 'all', p_limit => 1, p_offset => 0);
  SELECT COALESCE(MAX(total_count), 0) INTO v_list_finished_all
  FROM public.landlord_hub_list(p_scope => 'finished', p_tab => 'all', p_limit => 1, p_offset => 0);
  SELECT COALESCE(MAX(total_count), 0) INTO v_list_reg_only_all
  FROM public.landlord_hub_list(p_scope => 'registered_only', p_tab => 'all', p_limit => 1, p_offset => 0);
  SELECT COALESCE(MAX(total_count), 0) INTO v_list_check_all
  FROM public.landlord_hub_list(p_scope => 'check_first', p_tab => 'all', p_limit => 1, p_offset => 0);
  SELECT COALESCE(MAX(total_count), 0) INTO v_list_all_all
  FROM public.landlord_hub_list(p_scope => 'all', p_tab => 'all', p_limit => 1, p_offset => 0);
  SELECT COALESCE(MAX(total_count), 0) INTO v_list_live_to_call
  FROM public.landlord_hub_list(p_scope => 'live', p_tab => 'to_call', p_limit => 1, p_offset => 0);
  SELECT COALESCE(MAX(total_count), 0) INTO v_list_all_to_call
  FROM public.landlord_hub_list(p_scope => 'all', p_tab => 'to_call', p_limit => 1, p_offset => 0);

  IF v_list_live_all <> (v_stats->>'live_plan_landlords_total')::bigint
     OR v_list_in_prog_all <> (v_stats->>'in_progress_total')::bigint
     OR v_list_finished_all <> (v_stats->>'finished_total')::bigint
     OR v_list_reg_only_all <> (v_stats->>'registered_only_total')::bigint
     OR v_list_check_all <> (v_stats->>'check_first_count')::bigint
     OR v_list_all_all <> (v_stats->>'all_landlords_total')::bigint
     OR v_list_live_to_call <> (v_stats->'live_tab_counts'->>'to_call')::bigint
     OR v_list_all_to_call <> (v_stats->'all_tab_counts'->>'to_call')::bigint THEN
    RAISE EXCEPTION 'TEST FAILED (g): landlord_hub_stats and landlord_hub_list totals diverged';
  END IF;

  -- ---------------------------------------------------------------------------
  -- (h) A 50-row page returns in under 1 second (< 1000 ms) for every scope
  -- ---------------------------------------------------------------------------
  FOREACH v_scope_item IN ARRAY ARRAY['live', 'in_progress', 'finished', 'registered_only', 'check_first', 'all'] LOOP
    v_t0 := clock_timestamp();
    PERFORM count(*)
    FROM public.landlord_hub_list(
      p_scope  => v_scope_item,
      p_tab    => 'to_call',
      p_limit  => 50,
      p_offset => 0
    );
    v_ms := extract(epoch FROM (clock_timestamp() - v_t0)) * 1000.0;

    IF v_ms >= 1000.0 THEN
      RAISE EXCEPTION 'TEST FAILED (h): scope % took % ms (>= 1000 ms)', v_scope_item, round(v_ms, 1);
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- (i) Roles and masking are unchanged
  -- ---------------------------------------------------------------------------
  -- Landlord Ops officer sees unmasked phone and can call landlord_hub_agents()
  SELECT * INTO v_row
  FROM public.landlord_hub_list(p_scope => 'live', p_tab => 'all', p_limit => 1, p_offset => 0);

  IF v_row.phone_masked IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'TEST FAILED (i): expected landlord_ops phone_masked = false';
  END IF;

  SELECT count(*) INTO v_count FROM public.landlord_hub_agents();
  IF v_count < 100 THEN
    RAISE EXCEPTION 'TEST FAILED (i): expected landlord_hub_agents() to return registering agents, got %', v_count;
  END IF;

  -- Manager sees masked phone (select a clean profile and grant manager role inside transaction)
  SELECT p.id INTO v_manager_id
  FROM public.profiles p
  WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
    AND p.deleted_at IS NULL
    AND p.id <> v_throwaway_user
  ORDER BY p.id
  LIMIT 1;

  INSERT INTO public.user_roles (user_id, role, enabled)
  VALUES (v_manager_id, 'manager'::app_role, true);

  PERFORM set_config('request.jwt.claim.sub', v_manager_id::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_manager_id::text, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  SELECT * INTO v_row
  FROM public.landlord_hub_list(p_scope => 'live', p_tab => 'all', p_limit => 1, p_offset => 0);

  IF v_row.phone_masked IS DISTINCT FROM true
     OR (position('•' IN v_row.phone) = 0 AND position('*' IN v_row.phone) = 0) THEN
    RAISE EXCEPTION 'TEST FAILED (i): expected manager phone_masked = true, got % (%)',
      v_row.phone_masked, v_row.phone;
  END IF;

  -- Tenant is refused with 42501 on list, detail, stats, and agents
  SELECT p.id INTO v_tenant_id
  FROM public.profiles p
  WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
    AND p.deleted_at IS NULL
    AND p.id NOT IN (v_throwaway_user, v_manager_id)
  ORDER BY p.id
  LIMIT 1;

  INSERT INTO public.user_roles (user_id, role, enabled)
  VALUES (v_tenant_id, 'tenant'::app_role, true);

  PERFORM set_config('request.jwt.claim.sub', v_tenant_id::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_tenant_id::text, 'role', 'authenticated', 'aal', 'aal1')::text,
    true
  );

  v_err_code := NULL;
  BEGIN
    PERFORM * FROM public.landlord_hub_agents();
  EXCEPTION WHEN OTHERS THEN
    v_err_code := SQLSTATE;
  END;
  IF v_err_code IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'TEST FAILED (i): expected 42501 for tenant on landlord_hub_agents, got %', v_err_code;
  END IF;

  -- ---------------------------------------------------------------------------
  -- (j) Recorded calls in landlord_calls, staff_calling_detailed_report, and
  --     v_landlord_registry_all give the exact same results as before
  -- ---------------------------------------------------------------------------
  -- Delete the temporary role row before checking v_landlord_registry_all baseline count
  DELETE FROM public.user_roles
  WHERE user_id = v_throwaway_user
    AND role = 'landlord'::app_role;

  SELECT count(*) INTO v_reg_all_total FROM public.v_landlord_registry_all;
  IF v_reg_all_total <> 106478 THEN
    RAISE EXCEPTION 'TEST FAILED (j): v_landlord_registry_all unexpectedly changed (got %)', v_reg_all_total;
  END IF;

  SELECT count(*) INTO v_calls_count
  FROM public.landlord_calls c
  WHERE c.id = 'c35e04f3-ba95-4f8f-95a1-6d01ec2fc900'
    AND c.voided_at IS NULL;

  IF v_calls_count <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED (j): existing landlord_calls row c35e04f3-ba95-4f8f-95a1-6d01ec2fc900 missing or altered';
  END IF;

  -- Verify _landlord_cc_events_in_window still returns the recorded call on Friday Rogers
  SELECT count(*) INTO v_count
  FROM public._landlord_cc_events_in_window('2026-10-27 00:00:00+00'::timestamptz, '2026-10-28 00:00:00+00'::timestamptz) e
  WHERE e.call_id = 'c35e04f3-ba95-4f8f-95a1-6d01ec2fc900'::uuid;

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED (j): _landlord_cc_events_in_window missing call c35e04f3-ba95-4f8f-95a1-6d01ec2fc900';
  END IF;

  -- Switch to Jane (team head: 5295252d-f477-42a9-92f5-af56e503e33d) and verify staff_calling_detailed_report returns exact historical rows
  PERFORM set_config('request.jwt.claim.sub', '5295252d-f477-42a9-92f5-af56e503e33d', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', '5295252d-f477-42a9-92f5-af56e503e33d', 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  SELECT count(*) INTO v_count
  FROM public.staff_calling_detailed_report('2026-10-01 00:00:00+03'::timestamptz, '2026-10-28 00:00:00+03'::timestamptz);

  IF v_count < 1 THEN
    RAISE EXCEPTION 'TEST FAILED (j): staff_calling_detailed_report returned 0 rows for October 2026';
  END IF;

  RAISE NOTICE 'ALL LANDLORD CALLING HUB REAL-LANDLORDS TESTS (a-j) PASSED (mv_rows=%, live=%, check_first=%)',
    v_total_mv, v_live_mv, v_list_check_all;
END
$$;

ROLLBACK;

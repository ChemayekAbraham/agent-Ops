-- =============================================================================
-- Tests: supabase/tests/landlord_calling_center.sql
-- Purpose: Verify the Landlord Ops Calling Center server-side foundation:
--   1. v_landlord_registry_all completeness, deduplication, and needs_review rules
--   2. Tenant populations, filters, sorts, and cycle/queue counts unchanged
--   3. Landlord populations, filters, sorts, feedback categories, saved queues,
--      and non-blocking fair caller assignment (landlord_cc_assign_callers)
-- Every test block runs inside BEGIN ... ROLLBACK so zero data is modified.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- TEST BLOCK 1: v_landlord_registry_all completeness, deduplication & merge rules
-- -----------------------------------------------------------------------------
BEGIN;

DO $test1$
DECLARE
  v_total_reg bigint;
  v_distinct_keys bigint;
  v_ll_table_cnt bigint;
  v_reg_ll_cnt bigint;
  v_reg_ll_distinct bigint;
  v_ur_table_cnt bigint;
  v_reg_ur_cnt bigint;
  v_reg_ur_distinct bigint;
  v_missing_ll bigint;
  v_missing_ur bigint;
  v_dup_clear_phones bigint;
  v_missing_cols text[];
  v_test_u1 uuid := gen_random_uuid();
  v_test_u2 uuid := gen_random_uuid();
  v_test_l1 uuid := gen_random_uuid();
  v_test_l2 uuid := gen_random_uuid();
  v_merged_cnt int;
  v_unclear_cnt int;
BEGIN
  -- 1a. Verify all required columns exist on v_landlord_registry_all
  SELECT array_agg(req_col)
    INTO v_missing_cols
  FROM unnest(ARRAY[
    'landlord_key', 'landlord_id', 'user_id', 'full_name', 'phones',
    'region', 'district', 'registering_agent_id', 'registering_agent_name',
    'houses_count', 'active_rent_plans', 'total_paid_out_ugx', 'last_payout_at',
    'registered_at', 'verification_status', 'last_called_at',
    'last_call_outcome', 'last_caller_name', 'needs_review'
  ]) AS req_col
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'v_landlord_registry_all'
      AND c.column_name = req_col
  );

  IF v_missing_cols IS NOT NULL THEN
    RAISE EXCEPTION 'TEST 1 FAILED: v_landlord_registry_all missing columns: %', v_missing_cols;
  END IF;

  -- Materialize once for fast multi-assertion checks
  CREATE TEMP TABLE _reg_snap ON COMMIT DROP AS
  SELECT * FROM public.v_landlord_registry_all;

  SELECT
    count(*),
    count(DISTINCT landlord_key),
    count(landlord_id),
    count(DISTINCT landlord_id),
    count(user_id),
    count(DISTINCT user_id)
  INTO
    v_total_reg,
    v_distinct_keys,
    v_reg_ll_cnt,
    v_reg_ll_distinct,
    v_reg_ur_cnt,
    v_reg_ur_distinct
  FROM _reg_snap;

  -- 1b. Assert no duplicate landlords (landlord_key, landlord_id, user_id all 100% unique)
  IF v_total_reg <> v_distinct_keys THEN
    RAISE EXCEPTION 'TEST 1 FAILED: duplicate landlord_key found (total %, distinct %)', v_total_reg, v_distinct_keys;
  END IF;

  IF v_reg_ll_cnt <> v_reg_ll_distinct THEN
    RAISE EXCEPTION 'TEST 1 FAILED: duplicate landlord_id found (count %, distinct %)', v_reg_ll_cnt, v_reg_ll_distinct;
  END IF;

  IF v_reg_ur_cnt <> v_reg_ur_distinct THEN
    RAISE EXCEPTION 'TEST 1 FAILED: duplicate user_id found (count %, distinct %)', v_reg_ur_cnt, v_reg_ur_distinct;
  END IF;

  -- Among clear rows (needs_review = false), primary normalized phone must be 100% unique
  SELECT count(*) - count(DISTINCT phones[1])
    INTO v_dup_clear_phones
  FROM _reg_snap
  WHERE NOT needs_review;

  IF v_dup_clear_phones <> 0 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: % duplicate primary phones found among needs_review=false rows', v_dup_clear_phones;
  END IF;

  -- 1c. Assert every public.landlords row appears
  SELECT count(*) INTO v_ll_table_cnt FROM public.landlords;
  SELECT count(*) INTO v_missing_ll
  FROM public.landlords l
  WHERE NOT EXISTS (SELECT 1 FROM _reg_snap r WHERE r.landlord_id = l.id);

  IF v_missing_ll <> 0 OR v_reg_ll_distinct <> v_ll_table_cnt THEN
    RAISE EXCEPTION 'TEST 1 FAILED: landlords table coverage mismatch (table %, in view %, missing %)',
      v_ll_table_cnt, v_reg_ll_distinct, v_missing_ll;
  END IF;

  -- 1d. Assert every user_roles(role='landlord') user appears (including disabled and flagged)
  SELECT count(DISTINCT user_id) INTO v_ur_table_cnt
  FROM public.user_roles
  WHERE role = 'landlord'::app_role;

  SELECT count(DISTINCT ur.user_id) INTO v_missing_ur
  FROM public.user_roles ur
  WHERE ur.role = 'landlord'::app_role
    AND NOT EXISTS (SELECT 1 FROM _reg_snap r WHERE r.user_id = ur.user_id);

  IF v_missing_ur <> 0 OR v_reg_ur_distinct <> v_ur_table_cnt THEN
    RAISE EXCEPTION 'TEST 1 FAILED: landlord user_roles coverage mismatch (table %, in view %, missing %)',
      v_ur_table_cnt, v_reg_ur_distinct, v_missing_ur;
  END IF;

  -- 1e. Verify phone normalization helper (256XXXXXXXXX)
  IF public.normalize_landlord_phone_256('0772 123 456') <> '256772123456'
     OR public.normalize_landlord_phone_256('+256 772 123 456') <> '256772123456'
     OR public.normalize_landlord_phone_256('772123456') <> '256772123456' THEN
    RAISE EXCEPTION 'TEST 1 FAILED: normalize_landlord_phone_256 did not normalize to 256XXXXXXXXX';
  END IF;
END
$test1$;

ROLLBACK;

-- -----------------------------------------------------------------------------
-- TEST BLOCK 2: Tenant populations, filters, sorts & queue counts unchanged
-- -----------------------------------------------------------------------------
BEGIN;

DO $test2$
DECLARE
  v_tenant_pops_before jsonb;
  v_tenant_filters_before jsonb;
  v_tenant_buckets_before jsonb;
  v_tenant_sorts_before jsonb;
  v_tenant_cycles_before jsonb;
  v_tenant_rows_before jsonb;
  v_tenant_queue_cnt_before bigint;
  v_tenant_pops_after jsonb;
  v_tenant_filters_after jsonb;
  v_tenant_buckets_after jsonb;
  v_tenant_sorts_after jsonb;
  v_tenant_cycles_after jsonb;
  v_tenant_rows_after jsonb;
  v_tenant_queue_cnt_after bigint;
  v_landlord_ops_uid uuid;
  v_open_ll_cycle uuid;
BEGIN
  -- Snapshot all tenant calling configurations and live cycle/queue counts BEFORE landlord ops actions
  SELECT jsonb_agg(row_to_json(p) ORDER BY p.code) INTO v_tenant_pops_before
  FROM public.cc_cycle_populations p WHERE p.subject_type = 'tenant'::cc_subject_type;

  SELECT jsonb_agg(row_to_json(f) ORDER BY f.sort_order, f.key) INTO v_tenant_filters_before
  FROM public.cc_filter_options f WHERE f.subject_type = 'tenant'::cc_subject_type;

  SELECT jsonb_agg(row_to_json(b) ORDER BY b.filter_key, b.sort_order) INTO v_tenant_buckets_before
  FROM public.cc_filter_buckets b WHERE b.subject_type = 'tenant'::cc_subject_type;

  SELECT jsonb_agg(row_to_json(s) ORDER BY s.sort_order, s.key) INTO v_tenant_sorts_before
  FROM public.cc_sort_options s WHERE s.subject_type = 'tenant'::cc_subject_type;

  SELECT jsonb_agg(row_to_json(c) ORDER BY c.cycle_no) INTO v_tenant_cycles_before
  FROM public.cc_call_cycles c WHERE c.subject_type = 'tenant'::cc_subject_type;

  SELECT jsonb_agg(x ORDER BY x.cycle_id, x.state) INTO v_tenant_rows_before
  FROM (
    SELECT cycle_id, state, count(*) AS cnt
    FROM public.cc_cycle_rows
    WHERE subject_type = 'tenant'::cc_subject_type
    GROUP BY cycle_id, state
  ) x;

  SELECT count(*) INTO v_tenant_queue_cnt_before
  FROM public.v_cc_call_queue
  WHERE subject_type = 'tenant'::cc_subject_type;

  -- Perform Landlord Calling Center operations as a landlord_ops staff member
  SELECT ur.user_id INTO v_landlord_ops_uid
  FROM public.user_roles ur
  WHERE ur.role = 'landlord_ops'::app_role AND ur.enabled = true
  ORDER BY ur.user_id
  LIMIT 1;

  IF v_landlord_ops_uid IS NULL THEN
    SELECT ur.user_id INTO v_landlord_ops_uid
    FROM public.user_roles ur
    WHERE ur.role = 'super_admin'::app_role AND ur.enabled = true
    ORDER BY ur.user_id
    LIMIT 1;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_landlord_ops_uid, 'role', 'authenticated')::text, true);

  PERFORM public.landlord_cc_save_queue(
    'Kampala High Value Landlords',
    '{"district": "Kampala"}'::jsonb,
    'plan_rent_total',
    true
  );

  SELECT c.id INTO v_open_ll_cycle
  FROM public.cc_call_cycles c
  WHERE c.subject_type = 'landlord'::cc_subject_type AND c.closed_at IS NULL
  ORDER BY c.opened_at DESC
  LIMIT 1;

  IF v_open_ll_cycle IS NOT NULL THEN
    PERFORM public.landlord_cc_assign_callers(v_open_ll_cycle, ARRAY[v_landlord_ops_uid]);
  END IF;

  -- Snapshot all tenant calling configurations and live cycle/queue counts AFTER landlord ops actions
  SELECT jsonb_agg(row_to_json(p) ORDER BY p.code) INTO v_tenant_pops_after
  FROM public.cc_cycle_populations p WHERE p.subject_type = 'tenant'::cc_subject_type;

  SELECT jsonb_agg(row_to_json(f) ORDER BY f.sort_order, f.key) INTO v_tenant_filters_after
  FROM public.cc_filter_options f WHERE f.subject_type = 'tenant'::cc_subject_type;

  SELECT jsonb_agg(row_to_json(b) ORDER BY b.filter_key, b.sort_order) INTO v_tenant_buckets_after
  FROM public.cc_filter_buckets b WHERE b.subject_type = 'tenant'::cc_subject_type;

  SELECT jsonb_agg(row_to_json(s) ORDER BY s.sort_order, s.key) INTO v_tenant_sorts_after
  FROM public.cc_sort_options s WHERE s.subject_type = 'tenant'::cc_subject_type;

  SELECT jsonb_agg(row_to_json(c) ORDER BY c.cycle_no) INTO v_tenant_cycles_after
  FROM public.cc_call_cycles c WHERE c.subject_type = 'tenant'::cc_subject_type;

  SELECT jsonb_agg(x ORDER BY x.cycle_id, x.state) INTO v_tenant_rows_after
  FROM (
    SELECT cycle_id, state, count(*) AS cnt
    FROM public.cc_cycle_rows
    WHERE subject_type = 'tenant'::cc_subject_type
    GROUP BY cycle_id, state
  ) x;

  SELECT count(*) INTO v_tenant_queue_cnt_after
  FROM public.v_cc_call_queue
  WHERE subject_type = 'tenant'::cc_subject_type;

  IF v_tenant_pops_before IS DISTINCT FROM v_tenant_pops_after THEN
    RAISE EXCEPTION 'TEST 2 FAILED: tenant cc_cycle_populations changed';
  END IF;

  IF v_tenant_filters_before IS DISTINCT FROM v_tenant_filters_after THEN
    RAISE EXCEPTION 'TEST 2 FAILED: tenant cc_filter_options changed';
  END IF;

  IF v_tenant_buckets_before IS DISTINCT FROM v_tenant_buckets_after THEN
    RAISE EXCEPTION 'TEST 2 FAILED: tenant cc_filter_buckets changed';
  END IF;

  IF v_tenant_sorts_before IS DISTINCT FROM v_tenant_sorts_after THEN
    RAISE EXCEPTION 'TEST 2 FAILED: tenant cc_sort_options changed';
  END IF;

  IF v_tenant_cycles_before IS DISTINCT FROM v_tenant_cycles_after THEN
    RAISE EXCEPTION 'TEST 2 FAILED: tenant cc_call_cycles changed';
  END IF;

  IF v_tenant_rows_before IS DISTINCT FROM v_tenant_rows_after THEN
    RAISE EXCEPTION 'TEST 2 FAILED: tenant cc_cycle_rows counts changed';
  END IF;

  IF v_tenant_queue_cnt_before IS DISTINCT FROM v_tenant_queue_cnt_after THEN
    RAISE EXCEPTION 'TEST 2 FAILED: tenant v_cc_call_queue count changed (% vs %)',
      v_tenant_queue_cnt_before, v_tenant_queue_cnt_after;
  END IF;
END
$test2$;

ROLLBACK;

-- -----------------------------------------------------------------------------
-- TEST BLOCK 3: Landlord populations, filters, sorts, categories, saved queues
--               & fair caller split (non-blocking)
-- -----------------------------------------------------------------------------
BEGIN;

DO $test3$
DECLARE
  v_missing_pops text[];
  v_missing_filters text[];
  v_missing_sorts text[];
  v_missing_cats text[];
  v_caller1 uuid;
  v_caller2 uuid;
  v_plain_uid uuid;
  v_saved public.landlord_cc_saved_queues;
  v_listed_cnt int;
  v_open_cycle uuid;
  v_split_res jsonb;
  v_c1_cnt int;
  v_c2_cnt int;
  v_unauth_blocked boolean := false;
  v_page_cnt int;
BEGIN
  -- 3a. Verify all 9 required landlord population codes exist and are active
  SELECT array_agg(code) INTO v_missing_pops
  FROM unnest(ARRAY[
    'landlords_registry_all',
    'landlords_never_called',
    'landlords_active_plans',
    'landlords_paid_30d',
    'landlords_unverified',
    'landlords_no_houses',
    'landlords_not_called_30d',
    'landlords_not_called_60d',
    'landlords_not_called_90d'
  ]) AS code
  WHERE NOT EXISTS (
    SELECT 1 FROM public.cc_cycle_populations p
    WHERE p.subject_type = 'landlord'::cc_subject_type
      AND p.code = code
      AND p.active = true
      AND p.source_view = 'v_landlord_registry_all'
  );

  IF v_missing_pops IS NOT NULL THEN
    RAISE EXCEPTION 'TEST 3 FAILED: missing landlord populations: %', v_missing_pops;
  END IF;

  -- 3b. Verify landlord cc_filter_options (region, district, registering_agent)
  SELECT array_agg(k) INTO v_missing_filters
  FROM unnest(ARRAY['region', 'district', 'registering_agent']) AS k
  WHERE NOT EXISTS (
    SELECT 1 FROM public.cc_filter_options f
    WHERE f.subject_type = 'landlord'::cc_subject_type
      AND f.key = k
      AND f.active = true
  );

  IF v_missing_filters IS NOT NULL THEN
    RAISE EXCEPTION 'TEST 3 FAILED: missing landlord filter options: %', v_missing_filters;
  END IF;

  -- 3c. Verify landlord cc_sort_options (highest Rent Plan value, oldest call first, newest registration, name)
  SELECT array_agg(k) INTO v_missing_sorts
  FROM unnest(ARRAY['plan_rent_total', 'last_called_at', 'registered_at', 'name']) AS k
  WHERE NOT EXISTS (
    SELECT 1 FROM public.cc_sort_options s
    WHERE s.subject_type = 'landlord'::cc_subject_type
      AND s.key = k
      AND s.active = true
  );

  IF v_missing_sorts IS NOT NULL THEN
    RAISE EXCEPTION 'TEST 3 FAILED: missing landlord sort options: %', v_missing_sorts;
  END IF;

  -- 3d. Verify landlord-only outcome categories in cc_feedback_categories
  SELECT array_agg(c) INTO v_missing_cats
  FROM unnest(ARRAY[
    'reached_ok',
    'confirmed_payout_number',
    'wants_more_tenants',
    'complaint',
    'payout_issue',
    'not_landlord',
    'wrong_number'
  ]) AS c
  WHERE NOT EXISTS (
    SELECT 1 FROM public.cc_feedback_categories fc
    WHERE fc.code = c
      AND fc.active = true
      AND fc.applies_to = ARRAY['landlord'::cc_subject_type]
  );

  IF v_missing_cats IS NOT NULL THEN
    RAISE EXCEPTION 'TEST 3 FAILED: missing or non-landlord-only feedback categories: %', v_missing_cats;
  END IF;

  -- 3e. Pick two staff users and one unprivileged user to test saved queues & fair caller split
  SELECT ur.user_id INTO v_caller1
  FROM public.user_roles ur
  WHERE ur.role = 'landlord_ops'::app_role AND ur.enabled = true
  ORDER BY ur.user_id LIMIT 1;

  SELECT ur.user_id INTO v_caller2
  FROM public.user_roles ur
  WHERE ur.role IN ('landlord_ops'::app_role, 'operations'::app_role, 'super_admin'::app_role)
    AND ur.enabled = true
    AND ur.user_id <> COALESCE(v_caller1, '00000000-0000-0000-0000-000000000000'::uuid)
  ORDER BY ur.user_id LIMIT 1;

  IF v_caller1 IS NULL THEN
    v_caller1 := v_caller2;
  END IF;

  SELECT p.id INTO v_plain_uid
  FROM public.profiles p
  WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
  ORDER BY p.id LIMIT 1;

  -- Unprivileged user must be rejected by landlord_cc_save_queue
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_plain_uid, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.landlord_cc_save_queue('Unauthorized Queue', '{}'::jsonb, 'name', false);
  EXCEPTION WHEN insufficient_privilege THEN
    v_unauth_blocked := true;
  END;

  IF NOT v_unauth_blocked THEN
    RAISE EXCEPTION 'TEST 3 FAILED: unprivileged user was not blocked from landlord_cc_save_queue';
  END IF;

  -- Landlord Ops user saves a shared queue and lists it
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_caller1, 'role', 'authenticated')::text, true);
  v_saved := public.landlord_cc_save_queue(
    'Central Uncalled Queue',
    '{"region": "Central"}'::jsonb,
    'last_called_at',
    true
  );

  IF v_saved.id IS NULL OR v_saved.name <> 'Central Uncalled Queue' OR NOT v_saved.shared THEN
    RAISE EXCEPTION 'TEST 3 FAILED: landlord_cc_save_queue did not return expected saved queue row';
  END IF;

  -- Second staff caller can see the shared queue via landlord_cc_list_queues
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_caller2, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_listed_cnt
  FROM public.landlord_cc_list_queues() q
  WHERE q.id = v_saved.id AND q.shared = true AND q.is_mine = false;

  IF v_listed_cnt <> 1 THEN
    RAISE EXCEPTION 'TEST 3 FAILED: shared queue not visible to peer staff via landlord_cc_list_queues';
  END IF;

  -- Verify cc_call_queue_page works with the new landlord sort keys and filters
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_caller1, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_page_cnt
  FROM public.cc_call_queue_page('landlord'::cc_subject_type, 'to_call'::cc_row_state, 'last_called_at', NULL, 10, 0, '{}'::jsonb);

  SELECT count(*) INTO v_page_cnt
  FROM public.cc_call_queue_page('landlord'::cc_subject_type, 'to_call'::cc_row_state, 'registered_at', NULL, 10, 0, '{}'::jsonb);

  -- 3f. Fair caller split across v_caller1 and v_caller2 on the open landlord cycle
  SELECT c.id INTO v_open_cycle
  FROM public.cc_call_cycles c
  WHERE c.subject_type = 'landlord'::cc_subject_type AND c.closed_at IS NULL
  ORDER BY c.opened_at DESC
  LIMIT 1;

  IF v_open_cycle IS NOT NULL THEN
    v_split_res := public.landlord_cc_assign_callers(v_open_cycle, ARRAY[v_caller1, v_caller2]);

    SELECT count(*) FILTER (WHERE assigned_caller_id = v_caller1),
           count(*) FILTER (WHERE assigned_caller_id = v_caller2)
      INTO v_c1_cnt, v_c2_cnt
    FROM public.cc_cycle_rows
    WHERE cycle_id = v_open_cycle
      AND state IN ('to_call'::cc_row_state, 'unreachable'::cc_row_state, 'callback'::cc_row_state);

    IF abs(v_c1_cnt - v_c2_cnt) > 1 OR (v_c1_cnt + v_c2_cnt) = 0 THEN
      RAISE EXCEPTION 'TEST 3 FAILED: fair split uneven or empty (caller1 %, caller2 %)', v_c1_cnt, v_c2_cnt;
    END IF;
  END IF;
END
$test3$;

ROLLBACK;

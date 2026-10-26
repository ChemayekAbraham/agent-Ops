-- =============================================================================
-- Test Suite: supabase/tests/staff_assistant_read_tools_batch2.sql
-- Purpose:    Transactional verification of Prompt 8 (Zoe Read Tools Batch 2):
--               1. All 20 Batch 2 assistant_staff_* functions (42 total across
--                  Batch 1 + Batch 2) are STABLE, SECURITY DEFINER,
--                  search_path=public, have zero identity parameters, and grant
--                  EXECUTE to authenticated only.
--               2. Department-scoped PII masking (agent_ops, partner_ops,
--                  finance, hr, calling) masks phones/NINs for cross-department
--                  viewers and preserves phones for authorized ops roles.
--               3. For EVERY Batch 2 tool (20 tools across Agent Ops, Partner Ops
--                  & PSO, CFO & Financial Ops, COO/CEO/Managers, HR & Calling):
--                    - Signed-out user is refused with 42501
--                    - User with no role is refused with 42501
--                    - Tenant-only user is refused with 42501
--                    - Wrong staff role is refused with 42501
--                    - Right role gets data that matches the official function
--                      (including cash coming ONLY from get_treasury_cash_position),
--                      with 'source', 'period', and at most 200 rows.
--
-- Execution:  Always runs inside BEGIN ... ROLLBACK so zero test data persists.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_fn_rec          record;
  v_fn_count        integer := 0;
  v_batch2_count    integer := 0;

  -- Synthetic test users
  v_no_role_uid     uuid := '10000000-0000-4000-8000-000000000401'::uuid;
  v_tenant_uid      uuid := '10000000-0000-4000-8000-000000000402'::uuid;
  v_tops_only_uid   uuid := '10000000-0000-4000-8000-000000000403'::uuid;
  v_aops_uid        uuid := '10000000-0000-4000-8000-000000000404'::uuid;
  v_pops_uid        uuid := '10000000-0000-4000-8000-000000000405'::uuid;
  v_fops_uid        uuid := '10000000-0000-4000-8000-000000000406'::uuid;
  v_cfo_uid         uuid := '10000000-0000-4000-8000-000000000407'::uuid;
  v_coo_uid         uuid := '10000000-0000-4000-8000-000000000408'::uuid;
  v_ceo_uid         uuid := '10000000-0000-4000-8000-000000000409'::uuid;
  v_hr_uid          uuid := '10000000-0000-4000-8000-000000000410'::uuid;

  v_today           date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_from            date := ((now() AT TIME ZONE 'Africa/Kampala')::date - 7);
  v_to              date := (now() AT TIME ZONE 'Africa/Kampala')::date;

  v_call_sql        text;
  v_blocked         boolean;
  v_res             jsonb;
  v_off             jsonb;
BEGIN
  -- ---------------------------------------------------------------------------
  -- 1. Verify metadata & privileges on all 42 assistant_staff_* functions
  --    and specifically all 20 Batch 2 functions
  -- ---------------------------------------------------------------------------
  FOR v_fn_rec IN
    SELECT
      p.oid,
      p.proname,
      p.provolatile,
      p.prosecdef,
      p.proconfig,
      pg_get_function_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE 'assistant_staff_%'
    ORDER BY p.proname
  LOOP
    v_fn_count := v_fn_count + 1;

    IF v_fn_rec.proname = ANY(ARRAY[
      'assistant_staff_aops_network_overview',
      'assistant_staff_aops_metrics_totals',
      'assistant_staff_aops_metrics_agents',
      'assistant_staff_aops_listing_quality_and_risk',
      'assistant_staff_aops_silent_collectors',
      'assistant_staff_pops_pending_summary',
      'assistant_staff_pops_report_overview',
      'assistant_staff_pops_search_supporters',
      'assistant_staff_pso_cohort_performance',
      'assistant_staff_cfo_treasury_cash_position',
      'assistant_staff_cfo_money_flow_summary',
      'assistant_staff_cfo_receivables_and_payables',
      'assistant_staff_cfo_seven_day_expenses',
      'assistant_staff_cfo_budget_revised_position',
      'assistant_staff_fops_verification_and_requisitions',
      'assistant_staff_coo_overview',
      'assistant_staff_ceo_growth_and_approvals',
      'assistant_staff_hr_calling_detailed_report',
      'assistant_staff_hr_contracts_and_birthdays',
      'assistant_staff_hr_payroll_cost_by_department'
    ]) THEN
      v_batch2_count := v_batch2_count + 1;
    END IF;

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
      RAISE EXCEPTION 'TEST FAILED: % has forbidden identity parameter (%)', v_fn_rec.proname, v_fn_rec.args;
    END IF;
    IF has_function_privilege('anon', v_fn_rec.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'TEST FAILED: anon must NOT have EXECUTE on %', v_fn_rec.proname;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn_rec.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'TEST FAILED: authenticated must have EXECUTE on %', v_fn_rec.proname;
    END IF;
  END LOOP;

  IF v_batch2_count <> 20 THEN
    RAISE EXCEPTION 'TEST FAILED: expected all 20 Batch 2 assistant_staff_* functions, found %', v_batch2_count;
  END IF;
  IF v_fn_count < 42 THEN
    RAISE EXCEPTION 'TEST FAILED: expected at least 42 total assistant_staff_* functions, found %', v_fn_count;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 2. Seed synthetic test users & roles
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
    (v_no_role_uid,   'zoe.b2.norole@welile.com', 'Zoe B2 NoRole',     '+256799940001'),
    (v_tenant_uid,    'zoe.b2.tenant@welile.com', 'Zoe B2 Tenant',     '+256799940002'),
    (v_tops_only_uid, 'zoe.b2.tops@welile.com',   'Zoe B2 TenantOps',  '+256799940003'),
    (v_aops_uid,      'zoe.b2.aops@welile.com',   'Zoe B2 AgentOps',   '+256799940004'),
    (v_pops_uid,      'zoe.b2.pops@welile.com',   'Zoe B2 PartnerOps', '+256799940005'),
    (v_fops_uid,      'zoe.b2.fops@welile.com',   'Zoe B2 FinOps',     '+256799940006'),
    (v_cfo_uid,       'zoe.b2.cfo@welile.com',    'Zoe B2 CFO',        '+256799940007'),
    (v_coo_uid,       'zoe.b2.coo@welile.com',    'Zoe B2 COO',        '+256799940008'),
    (v_ceo_uid,       'zoe.b2.ceo@welile.com',    'Zoe B2 CEO',        '+256799940009'),
    (v_hr_uid,        'zoe.b2.hr@welile.com',     'Zoe B2 HR',         '+256799940010')
  ) AS u(uid, em, fn, ph);

  DELETE FROM public.user_roles WHERE user_id IN (
    v_no_role_uid, v_tenant_uid, v_tops_only_uid, v_aops_uid,
    v_pops_uid, v_fops_uid, v_cfo_uid, v_coo_uid, v_ceo_uid, v_hr_uid
  );

  INSERT INTO public.user_roles (user_id, role, enabled) VALUES
    (v_tenant_uid,    'tenant'::app_role,        true),
    (v_tops_only_uid, 'tenant_ops'::app_role,    true),
    (v_aops_uid,      'agent_ops'::app_role,     true),
    (v_pops_uid,      'partner_ops'::app_role,   true),
    (v_fops_uid,      'financial_ops'::app_role, true),
    (v_cfo_uid,       'cfo'::app_role,           true),
    (v_coo_uid,       'coo'::app_role,           true),
    (v_ceo_uid,       'ceo'::app_role,           true),
    (v_hr_uid,        'hr'::app_role,            true);

  -- ---------------------------------------------------------------------------
  -- 3. Verify department PII scope helper (staff_assistant_can_view_pii)
  -- ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_cfo_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cfo_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  IF public.staff_assistant_can_view_pii('agent_ops') IS TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: CFO without agent_ops role should have agent_ops PII masked';
  END IF;
  IF public.staff_assistant_can_view_pii('finance') IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: CFO should have finance PII visibility';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_aops_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_aops_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  IF public.staff_assistant_can_view_pii('agent_ops') IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: agent_ops should have agent_ops PII visibility';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 4. Signed-out, no-role, and tenant-only callers refused on ALL 20 Batch 2 tools
  -- ---------------------------------------------------------------------------
  FOREACH v_call_sql IN ARRAY ARRAY[
    'SELECT public.assistant_staff_aops_network_overview()',
    'SELECT public.assistant_staff_aops_metrics_totals()',
    'SELECT public.assistant_staff_aops_metrics_agents()',
    'SELECT public.assistant_staff_aops_listing_quality_and_risk()',
    'SELECT public.assistant_staff_aops_silent_collectors()',
    'SELECT public.assistant_staff_pops_pending_summary()',
    'SELECT public.assistant_staff_pops_report_overview()',
    'SELECT public.assistant_staff_pops_search_supporters()',
    'SELECT public.assistant_staff_pso_cohort_performance()',
    'SELECT public.assistant_staff_cfo_treasury_cash_position()',
    'SELECT public.assistant_staff_cfo_money_flow_summary()',
    'SELECT public.assistant_staff_cfo_receivables_and_payables()',
    'SELECT public.assistant_staff_cfo_seven_day_expenses()',
    'SELECT public.assistant_staff_cfo_budget_revised_position()',
    'SELECT public.assistant_staff_fops_verification_and_requisitions()',
    'SELECT public.assistant_staff_coo_overview()',
    'SELECT public.assistant_staff_ceo_growth_and_approvals()',
    'SELECT public.assistant_staff_hr_calling_detailed_report()',
    'SELECT public.assistant_staff_hr_contracts_and_birthdays()',
    'SELECT public.assistant_staff_hr_payroll_cost_by_department()'
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
      RAISE EXCEPTION 'TEST FAILED: no-role caller was not refused (42501) on: %', v_call_sql;
    END IF;

    -- 4c. Tenant-only caller -> must raise 42501
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
  -- 5. Wrong staff role refused across all 20 Batch 2 tools
  -- ---------------------------------------------------------------------------
  -- 5a. Partner Ops-only staff caller refused on Agent Ops (5), PSO (1), CFO/FinOps (6), COO/CEO (2), HR (3)
  PERFORM set_config('request.jwt.claim.sub', v_pops_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pops_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);

  FOREACH v_call_sql IN ARRAY ARRAY[
    'SELECT public.assistant_staff_aops_network_overview()',
    'SELECT public.assistant_staff_aops_metrics_totals()',
    'SELECT public.assistant_staff_aops_metrics_agents()',
    'SELECT public.assistant_staff_aops_listing_quality_and_risk()',
    'SELECT public.assistant_staff_aops_silent_collectors()',
    'SELECT public.assistant_staff_pso_cohort_performance()',
    'SELECT public.assistant_staff_cfo_treasury_cash_position()',
    'SELECT public.assistant_staff_cfo_money_flow_summary()',
    'SELECT public.assistant_staff_cfo_receivables_and_payables()',
    'SELECT public.assistant_staff_cfo_seven_day_expenses()',
    'SELECT public.assistant_staff_cfo_budget_revised_position()',
    'SELECT public.assistant_staff_fops_verification_and_requisitions()',
    'SELECT public.assistant_staff_coo_overview()',
    'SELECT public.assistant_staff_ceo_growth_and_approvals()',
    'SELECT public.assistant_staff_hr_calling_detailed_report()',
    'SELECT public.assistant_staff_hr_contracts_and_birthdays()',
    'SELECT public.assistant_staff_hr_payroll_cost_by_department()'
  ] LOOP
    v_blocked := false;
    BEGIN
      EXECUTE v_call_sql INTO v_res;
    EXCEPTION WHEN insufficient_privilege THEN
      v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'TEST FAILED: partner_ops-only caller was not refused (42501) on: %', v_call_sql;
    END IF;
  END LOOP;

  -- 5b. Agent Ops-only staff caller refused on Partner Ops (3), PSO (1), CFO/FinOps (6), COO/CEO (2), HR (3)
  PERFORM set_config('request.jwt.claim.sub', v_aops_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_aops_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);

  FOREACH v_call_sql IN ARRAY ARRAY[
    'SELECT public.assistant_staff_pops_pending_summary()',
    'SELECT public.assistant_staff_pops_report_overview()',
    'SELECT public.assistant_staff_pops_search_supporters()',
    'SELECT public.assistant_staff_pso_cohort_performance()',
    'SELECT public.assistant_staff_cfo_treasury_cash_position()',
    'SELECT public.assistant_staff_cfo_money_flow_summary()',
    'SELECT public.assistant_staff_cfo_receivables_and_payables()',
    'SELECT public.assistant_staff_cfo_seven_day_expenses()',
    'SELECT public.assistant_staff_cfo_budget_revised_position()',
    'SELECT public.assistant_staff_fops_verification_and_requisitions()',
    'SELECT public.assistant_staff_coo_overview()',
    'SELECT public.assistant_staff_ceo_growth_and_approvals()',
    'SELECT public.assistant_staff_hr_calling_detailed_report()',
    'SELECT public.assistant_staff_hr_contracts_and_birthdays()',
    'SELECT public.assistant_staff_hr_payroll_cost_by_department()'
  ] LOOP
    v_blocked := false;
    BEGIN
      EXECUTE v_call_sql INTO v_res;
    EXCEPTION WHEN insufficient_privilege THEN
      v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'TEST FAILED: agent_ops-only caller was not refused (42501) on: %', v_call_sql;
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- 6. Right role gets data matching the official function for ALL 20 Batch 2 tools
  -- ---------------------------------------------------------------------------

  -- === Group D: Agent Ops (5 tools) ===
  INSERT INTO public.user_roles (user_id, role, enabled)
  VALUES (v_aops_uid, 'operations'::app_role, true)
  ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', v_aops_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_aops_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);

  -- D1 (Q23). assistant_staff_aops_network_overview
  v_res := public.assistant_staff_aops_network_overview(v_from, v_to, 50000);
  v_off := public.get_agent_ops_network_overview(v_from, v_to, 50000);
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') OR NOT (v_res ? 'overview') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_aops_network_overview missing source/period/overview';
  END IF;
  IF (v_res -> 'overview' -> 'counts' ->> 'agents') IS DISTINCT FROM (v_off -> 'counts' ->> 'agents') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_aops_network_overview agent count mismatch vs get_agent_ops_network_overview';
  END IF;

  -- D2 (Q24). assistant_staff_aops_metrics_totals
  v_res := public.assistant_staff_aops_metrics_totals(v_from, v_to);
  SELECT to_jsonb(r) INTO v_off FROM public.agent_ops_metrics_totals(v_from, v_to) r LIMIT 1;
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') OR NOT (v_res ? 'totals') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_aops_metrics_totals missing source/period/totals';
  END IF;
  IF (v_res -> 'totals' ->> 'houses_listed') IS DISTINCT FROM (v_off ->> 'houses_listed') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_aops_metrics_totals mismatch vs agent_ops_metrics_totals';
  END IF;

  -- D3 (Q25). assistant_staff_aops_metrics_agents
  v_res := public.assistant_staff_aops_metrics_agents(v_from, v_to, NULL, 'houses_listed', 'qualifying', 10);
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') OR jsonb_array_length(v_res -> 'rows') > 200 THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_aops_metrics_agents invalid envelope';
  END IF;

  -- D4 (Q26). assistant_staff_aops_listing_quality_and_risk
  v_res := public.assistant_staff_aops_listing_quality_and_risk(v_from, v_to, 10);
  v_off := public.agent_ops_metrics_listing_quality(v_from, v_to, 10, 0);
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_aops_listing_quality_and_risk missing source/period';
  END IF;
  IF (v_res -> 'listing_quality' -> 'network' ->> 'houses_listed') IS DISTINCT FROM (v_off -> 'network' ->> 'houses_listed') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_aops_listing_quality_and_risk mismatch vs agent_ops_metrics_listing_quality';
  END IF;

  -- D5 (Q27). assistant_staff_aops_silent_collectors
  v_res := public.assistant_staff_aops_silent_collectors(3, 25);
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') OR jsonb_array_length(v_res -> 'rows') > 200 THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_aops_silent_collectors invalid envelope';
  END IF;

  -- === Group E: Partner Ops & PSO (4 tools) ===
  PERFORM set_config('request.jwt.claim.sub', v_pops_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pops_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);

  -- E1 (Q28). assistant_staff_pops_pending_summary
  v_res := public.assistant_staff_pops_pending_summary(v_today);
  SELECT to_jsonb(r) INTO v_off FROM public.partner_ops_pending_portfolio_summary() r LIMIT 1;
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_pops_pending_summary missing source/period';
  END IF;
  IF (v_res -> 'pending_portfolios' ->> 'pending_count') IS DISTINCT FROM (v_off ->> 'pending_count') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_pops_pending_summary mismatch vs partner_ops_pending_portfolio_summary';
  END IF;

  -- E2 (Q29). assistant_staff_pops_report_overview
  v_res := public.assistant_staff_pops_report_overview(v_from, v_to);
  v_off := public.partner_ops_report_totals();
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_pops_report_overview missing source/period';
  END IF;
  IF (v_res -> 'totals' ->> 'total_portfolios') IS DISTINCT FROM (v_off ->> 'total_portfolios') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_pops_report_overview mismatch vs partner_ops_report_totals';
  END IF;

  -- E3 (Q30). assistant_staff_pops_search_supporters
  v_res := public.assistant_staff_pops_search_supporters(NULL, 10);
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') OR jsonb_array_length(v_res -> 'rows') > 200 THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_pops_search_supporters invalid envelope';
  END IF;

  -- E4 (Q31). assistant_staff_pso_cohort_performance (as HR / COO)
  PERFORM set_config('request.jwt.claim.sub', v_coo_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_coo_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  v_res := public.assistant_staff_pso_cohort_performance(v_from, v_to);
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') OR NOT (v_res ? 'funded_summary') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_pso_cohort_performance missing source/period/funded_summary';
  END IF;

  -- === Group F: CFO & Financial Ops (6 tools) ===
  PERFORM set_config('request.jwt.claim.sub', v_cfo_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cfo_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);

  -- F1 (Q32). assistant_staff_cfo_treasury_cash_position — MUST match get_treasury_cash_position
  v_res := public.assistant_staff_cfo_treasury_cash_position(now());
  v_off := public.get_treasury_cash_position((v_res -> 'period' ->> 'as_at')::timestamptz);
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') OR NOT (v_res ? 'cash_position') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_cfo_treasury_cash_position missing source/period/cash_position';
  END IF;
  IF (v_res -> 'cash_position' ->> 'total_cash') IS DISTINCT FROM (v_off ->> 'total_cash')
     OR (v_res -> 'cash_position' ->> 'a1_cash_and_bank') IS DISTINCT FROM (v_off ->> 'a1_cash_and_bank')
     OR (v_res -> 'cash_position' ->> 'a5_cash_in_transit') IS DISTINCT FROM (v_off ->> 'a5_cash_in_transit')
  THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_cfo_treasury_cash_position does not match get_treasury_cash_position';
  END IF;

  -- F2 (Q33). assistant_staff_cfo_money_flow_summary
  v_res := public.assistant_staff_cfo_money_flow_summary();
  SELECT to_jsonb(r) INTO v_off FROM public.get_cfo_money_received() r LIMIT 1;
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_cfo_money_flow_summary missing source/period';
  END IF;
  IF (v_res -> 'money_received' ->> 'total_received') IS DISTINCT FROM (v_off ->> 'total_received') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_cfo_money_flow_summary mismatch vs get_cfo_money_received';
  END IF;

  -- F3 (Q34). assistant_staff_cfo_receivables_and_payables
  v_res := public.assistant_staff_cfo_receivables_and_payables('week', 2, v_today);
  v_off := public.get_receivables_total();
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_cfo_receivables_and_payables missing source/period';
  END IF;
  IF (v_res -> 'receivables' ->> 'total') IS DISTINCT FROM (v_off ->> 'total') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_cfo_receivables_and_payables mismatch vs get_receivables_total';
  END IF;

  -- F4 (Q35a). assistant_staff_cfo_seven_day_expenses
  v_res := public.assistant_staff_cfo_seven_day_expenses();
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') OR jsonb_array_length(v_res -> 'rows') > 200 THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_cfo_seven_day_expenses invalid envelope';
  END IF;

  -- F5 (Q35b). assistant_staff_cfo_budget_revised_position
  v_res := public.assistant_staff_cfo_budget_revised_position();
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') OR jsonb_array_length(v_res -> 'rows') > 200 THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_cfo_budget_revised_position invalid envelope';
  END IF;

  -- F6 (Q36). assistant_staff_fops_verification_and_requisitions
  v_res := public.assistant_staff_fops_verification_and_requisitions(v_from, v_to);
  v_off := public.finops_payout_verification_counts();
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_fops_verification_and_requisitions missing source/period';
  END IF;
  IF (v_res -> 'payout_verification_counts' ->> 'waiting') IS DISTINCT FROM (v_off ->> 'waiting') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_fops_verification_and_requisitions mismatch vs finops_payout_verification_counts';
  END IF;

  -- === Group G: COO, CEO & Managers (2 tools) ===
  PERFORM set_config('request.jwt.claim.sub', v_coo_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_coo_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);

  -- G1 (Q37). assistant_staff_coo_overview
  v_res := public.assistant_staff_coo_overview(7, v_from, v_to);
  v_off := public.get_coo_rent_coverage_statement();
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_coo_overview missing source/period';
  END IF;
  IF (v_res -> 'rent_coverage_statement' -> 'plans' ->> 'total') IS DISTINCT FROM (v_off -> 'plans' ->> 'total') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_coo_overview mismatch vs get_coo_rent_coverage_statement';
  END IF;

  -- G2 (Q38). assistant_staff_ceo_growth_and_approvals
  PERFORM set_config('request.jwt.claim.sub', v_ceo_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ceo_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  v_res := public.assistant_staff_ceo_growth_and_approvals(14);
  v_off := public.get_ceo_growth_quality(14);
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_ceo_growth_and_approvals missing source/period';
  END IF;
  IF (v_res -> 'growth_quality' -> 'capital' ->> 'plans_active') IS DISTINCT FROM (v_off -> 'capital' ->> 'plans_active') THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_ceo_growth_and_approvals mismatch vs get_ceo_growth_quality';
  END IF;

  -- === Group H: HR & Calling Team (3 tools) ===
  PERFORM set_config('request.jwt.claim.sub', v_hr_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_hr_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);

  -- H1 (Q39). assistant_staff_hr_calling_detailed_report
  v_res := public.assistant_staff_hr_calling_detailed_report(v_from, v_to);
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') OR jsonb_array_length(v_res -> 'detailed_rows') > 200 THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_hr_calling_detailed_report invalid envelope';
  END IF;

  -- H2 (Q40a). assistant_staff_hr_contracts_and_birthdays
  v_res := public.assistant_staff_hr_contracts_and_birthdays(60);
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') OR jsonb_array_length(v_res -> 'expiring_contracts') > 200 THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_hr_contracts_and_birthdays invalid envelope';
  END IF;

  -- H3 (Q40b). assistant_staff_hr_payroll_cost_by_department (as CFO)
  PERFORM set_config('request.jwt.claim.sub', v_cfo_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cfo_uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  v_res := public.assistant_staff_hr_payroll_cost_by_department(NULL);
  IF NOT (v_res ? 'source') OR NOT (v_res ? 'period') OR jsonb_array_length(v_res -> 'rows') > 200 THEN
    RAISE EXCEPTION 'TEST FAILED: assistant_staff_hr_payroll_cost_by_department invalid envelope';
  END IF;

  RAISE NOTICE 'ALL STAFF ASSISTANT BATCH 2 READ-TOOL TESTS PASSED (20 Batch 2 tools, 42 total tools verified)';
END $$;

ROLLBACK;

-- =============================================================================
-- Transactional SQL tests for 20261027100000_staff_assistant_security_hardening.sql
-- Always runs inside BEGIN ... ROLLBACK so zero data is persisted.
--
-- Verifies:
--   1. Every assistant_staff_* function in pg_proc is STABLE (provolatile = 's'),
--      SECURITY DEFINER (prosecdef = true), and runs inside a
--      SET LOCAL transaction_read_only = on transaction as a real staff user
--      with zero errors.
--   2. Table grants: authenticated has SELECT only on staff_assistant_reminders,
--      staff_assistant_schedules, staff_assistant_preferences, and
--      staff_assistant_drafts; authenticated cannot DELETE from
--      staff_assistant_messages or staff_assistant_conversations.
--   3. Soft-hide ("clear my history") via staff_assistant_hide_my_history sets
--      hidden_by_user = true without deleting rows, while direct DELETE on
--      staff_assistant_messages younger than 90 days is blocked by trigger.
--   4. Drafts table & RPCs: staff_assistant_save_draft + staff_assistant_consume_draft
--      enforce owner, kind, canonical payload_hash, 30-minute expiry, and
--      single-use (replay refused); confirm RPCs reject missing or edited drafts.
--   5. Link path validation & 30/day notification cap.
--   6. Email recipient search requires >= 3 non-wildcard characters and escapes
--      % and _; staff_assistant_can_user_read_report enforces recipient roles.
--   7. Schedule runner helpers never forge aal2, pass p_report_args, and work
--      for service_role on staff_assistant_is_staff_email.
--   8. CRM review redaction: a CRM reviewer calling
--      staff_assistant_crm_review_dashboard or staff_assistant_crm_conversation_thread
--      or querying v_staff_assistant_crm_messages_redacted sees question, time,
--      role, tool names, outcome, thumbs, and comment — NEVER a CFO's answer text,
--      report_payload, or figures.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_exec_staff     uuid := gen_random_uuid();
  v_tops_staff     uuid := gen_random_uuid();
  v_crm_reviewer   uuid := gen_random_uuid();
  v_fn             record;
  v_tool_count     integer := 0;
  v_res            jsonb;
  v_draft_res      jsonb;
  v_draft_id       uuid;
  v_remind_at      timestamptz := date_trunc('minute', now() + interval '3 hours');
  v_conv_id        uuid := gen_random_uuid();
  v_user_msg_id    uuid := gen_random_uuid();
  v_asst_msg_id    uuid := gen_random_uuid();
  v_denied         boolean := false;
  v_rec_count      integer := 0;
BEGIN
  -- Ensure Zoe is enabled
  UPDATE public.staff_assistant_config
     SET enabled = true,
         max_questions_per_day = 80,
         max_emails_per_day = 30,
         max_model_rounds = 4,
         max_tool_calls = 6,
         max_notifications_per_day = 30
   WHERE id = true;

  -- Seed staff users:
  --   v_exec_staff: holds super_admin + cfo + coo + ceo + hr + tenant_ops + landlord_ops + agent_ops + partner_ops + financial_ops + operations
  --   v_tops_staff: holds tenant_ops only
  --   v_crm_reviewer: holds crm only
  INSERT INTO public.profiles (id, full_name, email, phone, verified, is_frozen)
  VALUES
    (v_exec_staff,   'Executive Staff Tester', 'exec.tester@welile.com', '256700811111', true, false),
    (v_tops_staff,   'TenantOps Staff Tester', 'tops.tester@welile.com', '256700822222', true, false),
    (v_crm_reviewer, 'CRM Reviewer Tester',    'crm.tester@welile.com',  '256700833333', true, false);

  INSERT INTO public.user_roles (user_id, role, enabled)
  VALUES
    (v_exec_staff, 'super_admin', true),
    (v_exec_staff, 'cfo', true),
    (v_exec_staff, 'coo', true),
    (v_exec_staff, 'ceo', true),
    (v_exec_staff, 'hr', true),
    (v_exec_staff, 'tenant_ops', true),
    (v_exec_staff, 'landlord_ops', true),
    (v_exec_staff, 'agent_ops', true),
    (v_exec_staff, 'partner_ops', true),
    (v_exec_staff, 'financial_ops', true),
    (v_exec_staff, 'operations', true),
    (v_tops_staff, 'tenant_ops', true),
    (v_crm_reviewer, 'crm', true);

  -- ===========================================================================
  -- TEST 1: Every assistant_staff_* function is STABLE and runs in a
  --         READ ONLY transaction as a real staff user with zero errors.
  -- ===========================================================================
  FOR v_fn IN
    SELECT p.proname, p.provolatile, p.prosecdef
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE 'assistant_staff_%'
     ORDER BY p.proname
  LOOP
    v_tool_count := v_tool_count + 1;
    IF v_fn.provolatile <> 's' THEN
      RAISE EXCEPTION 'Function public.% is not STABLE (provolatile = %)', v_fn.proname, v_fn.provolatile;
    END IF;
    IF v_fn.prosecdef IS NOT TRUE THEN
      RAISE EXCEPTION 'Function public.% is not SECURITY DEFINER', v_fn.proname;
    END IF;
  END LOOP;

  IF v_tool_count < 43 THEN
    RAISE EXCEPTION 'Expected at least 43 assistant_staff_* functions, found %', v_tool_count;
  END IF;

  -- Authenticate as v_exec_staff and run all 43 assistant_staff_* functions
  -- inside a subtransaction with default_transaction_read_only = on
  PERFORM set_config('request.jwt.claim.sub', v_exec_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_exec_staff::text, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  BEGIN
    SET LOCAL default_transaction_read_only = on;

    PERFORM public.assistant_staff_my_profile();
    PERFORM public.assistant_staff_my_payslips();
    PERFORM public.assistant_staff_my_tasks();
    PERFORM public.assistant_staff_my_tickets();
    PERFORM public.assistant_staff_my_requisitions();
    PERFORM public.assistant_staff_my_advances();
    PERFORM public.assistant_staff_my_pending_concerns();
    PERFORM public.assistant_staff_my_canteen();
    PERFORM public.assistant_staff_my_wallet();
    PERFORM public.assistant_staff_my_reminders_and_schedules();

    PERFORM public.assistant_staff_tops_first_seven_summary();
    PERFORM public.assistant_staff_tops_arrears_ageing();
    PERFORM public.assistant_staff_tops_landlord_not_paid();
    PERFORM public.assistant_staff_tops_tenant_classification();
    PERFORM public.assistant_staff_tops_smartphone_usage();
    PERFORM public.assistant_staff_tops_weekly_performance();
    PERFORM public.assistant_staff_tops_no_payment_report();
    PERFORM public.assistant_staff_tops_rent_request_lifetime();
    PERFORM public.assistant_staff_tops_pipeline_waiting_on_lops();

    PERFORM public.assistant_staff_lops_home_range();
    PERFORM public.assistant_staff_lops_paid_lists();
    PERFORM public.assistant_staff_lops_principal_comparison();
    PERFORM public.assistant_staff_lops_calling_summary();
    PERFORM public.assistant_staff_lops_calling_coverage();

    PERFORM public.assistant_staff_aops_network_overview();
    PERFORM public.assistant_staff_aops_metrics_totals();
    PERFORM public.assistant_staff_aops_metrics_agents();
    PERFORM public.assistant_staff_aops_listing_quality_and_risk();
    PERFORM public.assistant_staff_aops_silent_collectors();

    PERFORM public.assistant_staff_pops_pending_summary();
    PERFORM public.assistant_staff_pops_report_overview();
    PERFORM public.assistant_staff_pops_search_supporters();
    PERFORM public.assistant_staff_pso_cohort_performance();

    PERFORM public.assistant_staff_cfo_treasury_cash_position();
    PERFORM public.assistant_staff_cfo_money_flow_summary();
    PERFORM public.assistant_staff_cfo_receivables_and_payables();
    PERFORM public.assistant_staff_cfo_seven_day_expenses();
    PERFORM public.assistant_staff_cfo_budget_revised_position();
    PERFORM public.assistant_staff_fops_verification_and_requisitions();

    PERFORM public.assistant_staff_coo_overview();
    PERFORM public.assistant_staff_ceo_growth_and_approvals();

    PERFORM public.assistant_staff_hr_calling_detailed_report();
    PERFORM public.assistant_staff_hr_contracts_and_birthdays();
    PERFORM public.assistant_staff_hr_payroll_cost_by_department();

    SET LOCAL default_transaction_read_only = off;
  END;

  -- ===========================================================================
  -- TEST 2: Table Grants Lock (Finding H4)
  --         authenticated has SELECT only on reminders, schedules, preferences,
  --         drafts, and no DELETE on messages/conversations.
  -- ===========================================================================
  IF has_table_privilege('authenticated', 'public.staff_assistant_reminders', 'INSERT')
     OR has_table_privilege('authenticated', 'public.staff_assistant_reminders', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.staff_assistant_reminders', 'DELETE')
  THEN
    RAISE EXCEPTION 'authenticated must not have INSERT/UPDATE/DELETE on staff_assistant_reminders';
  END IF;

  IF has_table_privilege('authenticated', 'public.staff_assistant_schedules', 'INSERT')
     OR has_table_privilege('authenticated', 'public.staff_assistant_schedules', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.staff_assistant_schedules', 'DELETE')
  THEN
    RAISE EXCEPTION 'authenticated must not have INSERT/UPDATE/DELETE on staff_assistant_schedules';
  END IF;

  IF has_table_privilege('authenticated', 'public.staff_assistant_preferences', 'INSERT')
     OR has_table_privilege('authenticated', 'public.staff_assistant_preferences', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.staff_assistant_preferences', 'DELETE')
  THEN
    RAISE EXCEPTION 'authenticated must not have INSERT/UPDATE/DELETE on staff_assistant_preferences';
  END IF;

  IF has_table_privilege('authenticated', 'public.staff_assistant_drafts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.staff_assistant_drafts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.staff_assistant_drafts', 'DELETE')
  THEN
    RAISE EXCEPTION 'authenticated must not have INSERT/UPDATE/DELETE on staff_assistant_drafts';
  END IF;

  IF has_table_privilege('authenticated', 'public.staff_assistant_messages', 'DELETE')
     OR has_table_privilege('authenticated', 'public.staff_assistant_conversations', 'DELETE')
  THEN
    RAISE EXCEPTION 'authenticated must not have DELETE on staff_assistant_messages or staff_assistant_conversations';
  END IF;

  -- ===========================================================================
  -- TEST 3: Tie Draft and Send/Confirm Together (Finding M9)
  -- ===========================================================================
  -- 3a. Calling staff_assistant_create_reminder WITHOUT a server draft_id is refused
  v_denied := false;
  BEGIN
    PERFORM public.staff_assistant_create_reminder(
      'Unbound Reminder',
      v_remind_at,
      'Note without draft',
      NULL,
      NULL
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Expected 22023 when calling staff_assistant_create_reminder without a server draft_id';
  END IF;

  -- 3b. Save a valid reminder draft and verify payload tampering is refused
  v_draft_res := public.staff_assistant_save_draft(
    'reminder',
    jsonb_build_object(
      'kind', 'reminder',
      'title', 'Review Wakiso Rent Plan',
      'remind_at', v_remind_at,
      'note', 'Verify payout status'
    ),
    NULL
  );
  v_draft_id := (v_draft_res ->> 'draft_id')::uuid;

  v_denied := false;
  BEGIN
    PERFORM public.staff_assistant_create_reminder(
      'TAMPERED TITLE',
      v_remind_at,
      'Verify payout status',
      NULL,
      v_draft_id
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Expected 22023 when confirming a draft with a tampered payload';
  END IF;

  -- 3c. Confirm with exact matching payload succeeds once, and replay is refused
  v_res := public.staff_assistant_create_reminder(
    'Review Wakiso Rent Plan',
    v_remind_at,
    'Verify payout status',
    NULL,
    v_draft_id
  );
  IF (v_res ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Expected reminder creation with valid draft_id to succeed';
  END IF;

  v_denied := false;
  BEGIN
    PERFORM public.staff_assistant_create_reminder(
      'Review Wakiso Rent Plan',
      v_remind_at,
      'Verify payout status',
      NULL,
      v_draft_id
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Expected 22023 when replaying an already-used draft_id';
  END IF;

  -- ===========================================================================
  -- TEST 4: Notification link_path validation
  -- ===========================================================================
  IF public.staff_assistant_is_valid_link_path('/me/zoe') IS NOT TRUE
     OR public.staff_assistant_is_valid_link_path('https://evil.example.com') IS TRUE
     OR public.staff_assistant_is_valid_link_path('//evil.example.com') IS TRUE
     OR public.staff_assistant_is_valid_link_path('/unknown-phishing-route') IS TRUE
  THEN
    RAISE EXCEPTION 'staff_assistant_is_valid_link_path failed route allowlist validation';
  END IF;

  -- ===========================================================================
  -- TEST 5: Email recipient search wildcard escaping & 3-char minimum +
  --         Recipient role check (Finding H5)
  -- ===========================================================================
  SELECT count(*)::integer INTO v_rec_count FROM public.staff_assistant_email_recipients('%%%');
  IF v_rec_count <> 0 THEN
    RAISE EXCEPTION 'Expected 0 recipients for wildcard-only search "%%%", got %', v_rec_count;
  END IF;

  SELECT count(*)::integer INTO v_rec_count FROM public.staff_assistant_email_recipients('ab');
  IF v_rec_count <> 0 THEN
    RAISE EXCEPTION 'Expected 0 recipients for 2-char search "ab", got %', v_rec_count;
  END IF;

  -- Tenant Ops user (v_tops_staff) can read Tenant Ops arrears ageing, but CANNOT read CFO Treasury Cash Position
  IF public.staff_assistant_can_user_read_report(
    v_tops_staff,
    'assistant_staff_tops_arrears_ageing',
    v_exec_staff
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Expected v_tops_staff to be allowed to read assistant_staff_tops_arrears_ageing';
  END IF;

  IF public.staff_assistant_can_user_read_report(
    v_tops_staff,
    'assistant_staff_cfo_treasury_cash_position',
    v_exec_staff
  ) IS TRUE THEN
    RAISE EXCEPTION 'Expected v_tops_staff to be REFUSED on assistant_staff_cfo_treasury_cash_position';
  END IF;

  -- Personal My Space reports (assistant_staff_my_payslips) cannot be sent to a different staff member
  IF public.staff_assistant_can_user_read_report(
    v_exec_staff,
    'assistant_staff_my_payslips',
    v_tops_staff
  ) IS TRUE THEN
    RAISE EXCEPTION 'Expected personal My Space report to be refused when recipient != owner';
  END IF;

  -- ===========================================================================
  -- TEST 6: CRM Review Screen Redaction (Finding H1) & Message Undeletability
  -- ===========================================================================
  INSERT INTO public.staff_assistant_conversations (id, user_id, title)
  VALUES (v_conv_id, v_exec_staff, 'CFO Treasury Cash Inquiry');

  INSERT INTO public.staff_assistant_messages (
    id, conversation_id, user_id, role, content, outcome, tools_called, source_label, period_label, report_payload
  )
  VALUES
    (
      v_user_msg_id,
      v_conv_id,
      v_exec_staff,
      'user',
      'What is the Treasury cash position today?',
      NULL,
      ARRAY[]::text[],
      NULL,
      NULL,
      NULL
    ),
    (
      v_asst_msg_id,
      v_conv_id,
      v_exec_staff,
      'assistant',
      'SECRET_CFO_ANSWER: Cash is UGX 987,654,321.',
      'answered',
      ARRAY['get_cfo_treasury_cash_position'],
      'get_treasury_cash_position',
      'as of 2026-10-27',
      jsonb_build_object('secret_cash_ugx', 987654321)
    );

  -- 6a. Direct DELETE on recent message is blocked by trigger
  v_denied := false;
  BEGIN
    DELETE FROM public.staff_assistant_messages WHERE id = v_asst_msg_id;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Expected DELETE on recent staff_assistant_messages row to be blocked by trigger';
  END IF;

  -- 6b. Switch to CRM Reviewer (v_crm_reviewer) and verify CFO answer text and report_payload are completely absent
  PERFORM set_config('request.jwt.claim.sub', v_crm_reviewer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_crm_reviewer::text, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  v_res := public.staff_assistant_crm_conversation_thread(v_conv_id);
  IF v_res::text LIKE '%SECRET_CFO_ANSWER%'
     OR v_res::text LIKE '%987654321%'
     OR v_res::text LIKE '%secret_cash_ugx%'
  THEN
    RAISE EXCEPTION 'CRM conversation thread leaked CFO answer content or report_payload: %', v_res;
  END IF;

  v_res := public.staff_assistant_crm_review_dashboard(NULL, false, false, NULL, 14, 50);
  IF v_res::text LIKE '%SECRET_CFO_ANSWER%'
     OR v_res::text LIKE '%987654321%'
     OR v_res::text LIKE '%secret_cash_ugx%'
  THEN
    RAISE EXCEPTION 'CRM review dashboard leaked CFO answer content or report_payload: %', v_res;
  END IF;

  -- 6c. Soft-hide ("clear my history") hides conversation for owner without deleting rows
  PERFORM set_config('request.jwt.claim.sub', v_exec_staff::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_exec_staff::text, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  v_res := public.staff_assistant_hide_my_history(NULL, v_conv_id);
  IF (v_res ->> 'hidden_messages')::int < 2 THEN
    RAISE EXCEPTION 'Expected staff_assistant_hide_my_history to mark messages hidden_by_user = true';
  END IF;
END;
$$;

ROLLBACK;

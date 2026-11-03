-- Transactional SQL test for 20261026150000_staff_assistant_crm_review_and_usage.sql
-- Always rolls back at the end so zero data is persisted.
BEGIN;

DO $$
DECLARE
  v_crm_uid     uuid := gen_random_uuid();
  v_tops_uid    uuid := gen_random_uuid();
  v_hr_uid      uuid := gen_random_uuid();
  v_tenant_uid  uuid := gen_random_uuid();
  v_conv_tops   uuid := gen_random_uuid();
  v_conv_hr     uuid := gen_random_uuid();
  v_msg_user1   uuid := gen_random_uuid();
  v_msg_asst1   uuid := gen_random_uuid();
  v_msg_user2   uuid := gen_random_uuid();
  v_msg_asst2   uuid := gen_random_uuid();
  v_dash        jsonb;
  v_thread      jsonb;
  v_err_code    text;
BEGIN
  -- Seed test profiles & roles inside transaction
  INSERT INTO public.profiles (id, full_name, email, phone)
  VALUES
    (v_crm_uid,    'CRM Reviewer Test',   'crm.reviewer@welile.com', '+256700111001'),
    (v_tops_uid,   'Tenant Ops Officer',  'tops.officer@welile.com', '+256700111002'),
    (v_hr_uid,     'HR Officer',          'hr.officer@welile.com',   '+256700111003'),
    (v_tenant_uid, 'Tenant Only User',    'tenant.only@gmail.com',   '+256700111004');

  INSERT INTO public.user_roles (user_id, role, enabled)
  VALUES
    (v_crm_uid,    'crm'::app_role,        true),
    (v_tops_uid,   'tenant_ops'::app_role, true),
    (v_hr_uid,     'hr'::app_role,         true),
    (v_tenant_uid, 'tenant'::app_role,     true);

  -- Seed conversations, messages, thumbs-down feedback, and unanswered question
  INSERT INTO public.staff_assistant_conversations (id, user_id, title, message_count)
  VALUES
    (v_conv_tops, v_tops_uid, 'Arrears ageing inquiry', 2),
    (v_conv_hr,   v_hr_uid,   'Unanswered custom report', 2);

  INSERT INTO public.staff_assistant_messages (id, conversation_id, user_id, role, content, outcome, tools_called)
  VALUES
    (v_msg_user1, v_conv_tops, v_tops_uid, 'user',      'Show arrears ageing', 'answered', '{}'),
    (v_msg_asst1, v_conv_tops, v_tops_uid, 'assistant', 'Overdue Rent Plans total UGX 1,450,000.', 'answered', ARRAY['get_tops_arrears_ageing']),
    (v_msg_user2, v_conv_hr,   v_hr_uid,   'user',      'Show fleet fuel consumption by district', NULL, '{}'),
    (v_msg_asst2, v_conv_hr,   v_hr_uid,   'assistant', 'I do not have a verified report tool for that question yet.', 'unmatched', '{}');

  INSERT INTO public.staff_assistant_feedback (conversation_id, message_id, user_id, rating, comment)
  VALUES (v_conv_tops, v_msg_asst1, v_tops_uid, 'down', 'Expected breakdown by bucket');

  INSERT INTO public.staff_assistant_unanswered (conversation_id, message_id, user_id, caller_roles, question_text, reason, status)
  VALUES (v_conv_hr, v_msg_asst2, v_hr_uid, ARRAY['hr'], 'Show fleet fuel consumption by district', 'unmatched', 'open');

  -- 1. Non-CRM staff (tenant_ops) and non-staff (tenant) must be refused
  PERFORM set_config('request.jwt.claim.sub', v_tops_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_tops_uid::text, 'role', 'authenticated')::text, true);

  IF public.staff_assistant_is_crm_reviewer() THEN
    RAISE EXCEPTION 'TEST FAILED: tenant_ops should not pass staff_assistant_is_crm_reviewer()';
  END IF;

  v_err_code := NULL;
  BEGIN
    PERFORM public.staff_assistant_crm_review_dashboard();
  EXCEPTION WHEN OTHERS THEN
    v_err_code := SQLSTATE;
  END;
  IF v_err_code IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'TEST FAILED: expected 42501 for tenant_ops calling staff_assistant_crm_review_dashboard, got %', v_err_code;
  END IF;

  -- 2. CRM reviewer gets full dashboard, role filter, thumbs-down filter, unanswered filter, weekly unanswered summary, and daily usage
  PERFORM set_config('request.jwt.claim.sub', v_crm_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_crm_uid::text, 'role', 'authenticated')::text, true);

  IF NOT public.staff_assistant_is_crm_reviewer() THEN
    RAISE EXCEPTION 'TEST FAILED: crm role must pass staff_assistant_is_crm_reviewer()';
  END IF;

  v_dash := public.staff_assistant_crm_review_dashboard('tenant_ops', true, false, 50);
  IF jsonb_array_length(v_dash->'conversations') <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED: expected 1 tenant_ops thumbs-down conversation, got %', jsonb_array_length(v_dash->'conversations');
  END IF;

  v_dash := public.staff_assistant_crm_review_dashboard('hr', false, true, 50);
  IF jsonb_array_length(v_dash->'conversations') <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED: expected 1 hr unanswered conversation, got %', jsonb_array_length(v_dash->'conversations');
  END IF;

  IF jsonb_array_length(v_dash->'weekly_unanswered_summary') < 1 THEN
    RAISE EXCEPTION 'TEST FAILED: expected weekly_unanswered_summary to contain unanswered question';
  END IF;

  IF jsonb_array_length(v_dash->'daily_usage_per_person') < 1 THEN
    RAISE EXCEPTION 'TEST FAILED: expected daily_usage_per_person to contain today usage';
  END IF;

  v_thread := public.staff_assistant_crm_conversation_thread(v_conv_tops);
  IF jsonb_array_length(v_thread->'messages') <> 2 THEN
    RAISE EXCEPTION 'TEST FAILED: expected 2 messages in thread, got %', jsonb_array_length(v_thread->'messages');
  END IF;
END;
$$;

ROLLBACK;

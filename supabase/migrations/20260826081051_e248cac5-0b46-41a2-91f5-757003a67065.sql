CREATE OR REPLACE FUNCTION public.smoke_promissory_support_modes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $smoke$
DECLARE
  v_result jsonb := '[]'::jsonb;
  v_stage text := 'init';
  v_agent uuid := '00000000-0000-4000-8000-00000000d203';
  v_self_user uuid := '00000000-0000-4000-8000-00000000d201';
  v_existing_user uuid := '00000000-0000-4000-8000-00000000d202';
  v_tenant uuid := '00000000-0000-4000-8000-00000000d204';
  v_landlord uuid := '00000000-0000-4000-8000-00000000d205';
  v_self_note uuid := '00000000-0000-4000-8000-00000000d206';
  v_existing_note uuid := '00000000-0000-4000-8000-00000000d207';
  v_rent_request uuid := '00000000-0000-4000-8000-00000000d208';
  v_commitment uuid;
  v_line uuid;
  v_self_context jsonb;
  v_existing_context jsonb;
  v_report jsonb;
  v_self_report_note jsonb;
  v_event_count int;
BEGIN
  BEGIN
    v_stage := 'seed_auth_users';
    INSERT INTO auth.users(id, email, created_at, updated_at, email_confirmed_at, raw_user_meta_data)
    VALUES
      (v_agent, 'promissory-smoke-agent@example.invalid', now(), now(), now(), jsonb_build_object('full_name','Rollback Promissory Agent','phone','0709999203','role','agent')),
      (v_self_user, 'promissory-smoke-self@example.invalid', now(), now(), now(), jsonb_build_object('full_name','Rollback Self Partner','phone','0709999201','role','supporter')),
      (v_existing_user, 'promissory-smoke-existing@example.invalid', now(), now(), now(), jsonb_build_object('full_name','Rollback Existing Partner','phone','0709999202','role','supporter')),
      (v_tenant, 'promissory-smoke-tenant@example.invalid', now(), now(), now(), jsonb_build_object('full_name','Rollback Promissory Tenant','phone','0709999204','role','tenant')),
      (v_landlord, 'promissory-smoke-landlord@example.invalid', now(), now(), now(), jsonb_build_object('full_name','Rollback Promissory Landlord','phone','0709999205','role','landlord'))
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, raw_user_meta_data = EXCLUDED.raw_user_meta_data, updated_at = now();

    v_stage := 'seed_base_profiles';
    INSERT INTO public.profiles(id, full_name, phone, email, role, created_at, updated_at)
    VALUES
      (v_agent, 'Rollback Promissory Agent', '0709999203', 'promissory-smoke-agent@example.invalid', 'agent', now(), now()),
      (v_tenant, 'Rollback Promissory Tenant', '0709999204', 'promissory-smoke-tenant@example.invalid', 'tenant', now(), now()),
      (v_landlord, 'Rollback Promissory Landlord', '0709999205', 'promissory-smoke-landlord@example.invalid', 'landlord', now(), now())
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, email = EXCLUDED.email, role = EXCLUDED.role, updated_at = now();

    v_stage := 'seed_cfo_authority';
    INSERT INTO public.user_roles(user_id, role)
    VALUES (v_agent, 'cfo')
    ON CONFLICT (user_id, role) DO NOTHING;

    v_stage := 'seed_rent_request';
    INSERT INTO public.rent_requests(
      id, tenant_id, landlord_id, agent_id, amount, daily_amount, status,
      tenant_name, tenant_phone, property_location, lease_start_date, lease_end_date,
      next_due_date, request_latitude, request_longitude, tenant_photo_url, created_at, updated_at
    ) VALUES (
      v_rent_request, v_tenant, v_landlord, v_agent, 100000, 3334, 'approved',
      'Rollback Promissory Tenant', '0709999204', 'Rollback Smoke House', current_date, current_date + 30,
      current_date + 30, 0, 0, 'https://example.invalid/tenant.jpg', now(), now()
    ) ON CONFLICT (id) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      landlord_id = EXCLUDED.landlord_id,
      agent_id = EXCLUDED.agent_id,
      amount = EXCLUDED.amount,
      daily_amount = EXCLUDED.daily_amount,
      status = EXCLUDED.status,
      tenant_name = EXCLUDED.tenant_name,
      tenant_phone = EXCLUDED.tenant_phone,
      property_location = EXCLUDED.property_location,
      lease_start_date = EXCLUDED.lease_start_date,
      lease_end_date = EXCLUDED.lease_end_date,
      next_due_date = EXCLUDED.next_due_date,
      request_latitude = EXCLUDED.request_latitude,
      request_longitude = EXCLUDED.request_longitude,
      tenant_photo_url = EXCLUDED.tenant_photo_url,
      updated_at = now();

    v_stage := 'seed_promissory_notes_before_partner_registration';
    INSERT INTO public.promissory_notes(id, agent_id, partner_name, whatsapp_number, phone_number, email, amount, status, support_mode)
    VALUES
      (v_self_note, v_agent, 'Rollback Self Partner', '0709999201', '0709999201', 'promissory-smoke-self@example.invalid', 100000, 'pending', 'self_support'),
      (v_existing_note, v_agent, 'Rollback Existing Partner', '0709999202', '0709999202', 'promissory-smoke-existing@example.invalid', 100000, 'pending', 'existing_support')
    ON CONFLICT (id) DO UPDATE SET
      agent_id = EXCLUDED.agent_id,
      partner_name = EXCLUDED.partner_name,
      whatsapp_number = EXCLUDED.whatsapp_number,
      phone_number = EXCLUDED.phone_number,
      email = EXCLUDED.email,
      amount = EXCLUDED.amount,
      status = EXCLUDED.status,
      support_mode = EXCLUDED.support_mode,
      partner_user_id = NULL,
      updated_at = now();

    v_stage := 'reserve_selected_rent_plan';
    INSERT INTO public.promissory_note_plan_intents(note_id, rent_request_id, agent_id, amount, status)
    VALUES (v_self_note, v_rent_request, v_agent, 100000, 'reserved')
    ON CONFLICT (note_id, rent_request_id) DO UPDATE SET status = EXCLUDED.status, amount = EXCLUDED.amount, updated_at = now();

    v_stage := 'partner_registration_autolink';
    INSERT INTO public.profiles(id, full_name, phone, email, role, created_at, updated_at)
    VALUES
      (v_self_user, 'Rollback Self Partner', '0709999201', 'promissory-smoke-self@example.invalid', 'supporter', now(), now()),
      (v_existing_user, 'Rollback Existing Partner', '0709999202', 'promissory-smoke-existing@example.invalid', 'supporter', now(), now())
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, email = EXCLUDED.email, role = EXCLUDED.role, updated_at = now();

    IF NOT EXISTS (SELECT 1 FROM public.promissory_notes WHERE id = v_self_note AND partner_user_id = v_self_user) THEN
      RAISE EXCEPTION 'AUTO_LINK_FAILED_SELF';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.promissory_notes WHERE id = v_existing_note AND partner_user_id = v_existing_user) THEN
      RAISE EXCEPTION 'AUTO_LINK_FAILED_EXISTING';
    END IF;
    v_result := v_result || jsonb_build_object('step','registration_came_in_autolinked','pass',true);

    v_stage := 'support_mode_context';
    v_self_context := public.promissory_self_support_context(v_self_user);
    v_existing_context := public.promissory_self_support_context(v_existing_user);
    v_result := v_result || jsonb_build_object('step','support_mode_context','pass', COALESCE((v_self_context->>'required')::boolean,false) AND NOT COALESCE((v_existing_context->>'required')::boolean,false) AND COALESCE((v_self_context->>'reserved_plans')::int,0) = 1 AND COALESCE((v_self_context->>'reserved_amount')::numeric,0) = 100000);

    v_stage := 'normal_portfolio_blocked_for_self_support';
    BEGIN
      INSERT INTO public.investor_portfolios(investor_id, agent_id, portfolio_code, investment_amount, duration_months, roi_percentage, roi_mode, status, portfolio_pin, activation_token)
      VALUES (v_self_user, v_agent, 'SMOKE-SELF-BLOCKED', 100000, 1, 15, 'monthly_payout', 'pending_ops_approval', '0000', gen_random_uuid());
      v_result := v_result || jsonb_build_object('step','normal_portfolio_blocked','pass',false);
    EXCEPTION WHEN check_violation THEN
      v_result := v_result || jsonb_build_object('step','normal_portfolio_blocked','pass', SQLERRM LIKE 'PROMISSORY_SELF_SUPPORT_REQUIRED%');
    END;

    v_stage := 'normal_portfolio_allowed_for_existing_support';
    INSERT INTO public.investor_portfolios(investor_id, agent_id, portfolio_code, investment_amount, duration_months, roi_percentage, roi_mode, status, portfolio_pin, activation_token)
    VALUES (v_existing_user, v_agent, 'SMOKE-EXISTING-OK', 100000, 1, 15, 'monthly_payout', 'pending_ops_approval', '0000', gen_random_uuid());
    v_result := v_result || jsonb_build_object('step','existing_support_normal_portfolio_allowed','pass',true);

    v_stage := 'dedicated_self_support_commitment_and_portfolio';
    INSERT INTO public.partner_self_commitments(partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status, promissory_note_id)
    VALUES (v_self_user, 100000, 1, 15, 1, 'smoke-self-support-' || v_self_note::text, 'pending_ops_approval', v_self_note)
    RETURNING id INTO v_commitment;

    INSERT INTO public.partner_self_funding_lines(commitment_id, partner_id, rent_request_id, principal, monthly_rate, term_months, status)
    VALUES (v_commitment, v_self_user, v_rent_request, 100000, 15, 1, 'committed')
    RETURNING id INTO v_line;

    UPDATE public.rent_requests
       SET self_funding_partner_id = v_self_user, self_funding_line_id = v_line, updated_at = now()
     WHERE id = v_rent_request;

    INSERT INTO public.investor_portfolios(investor_id, agent_id, portfolio_code, investment_amount, duration_months, roi_percentage, roi_mode, status, portfolio_pin, activation_token)
    VALUES (v_self_user, v_agent, 'SMOKE-SELF-OK', 100000, 1, 15, 'monthly_payout', 'pending_ops_approval', '0000', gen_random_uuid());

    UPDATE public.promissory_note_plan_intents
       SET status = 'funded', commitment_id = v_commitment, updated_at = now()
     WHERE note_id = v_self_note AND rent_request_id = v_rent_request;

    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('promissory.self_support.portfolio_created', v_self_user, 'promissory_notes', v_self_note, 'Smoke self-support portfolio audit event', jsonb_build_object('commitment_id', v_commitment, 'line_id', v_line, 'smoke', true));

    IF NOT EXISTS (SELECT 1 FROM public.rent_requests WHERE id = v_rent_request AND self_funding_partner_id = v_self_user AND self_funding_line_id = v_line) THEN
      RAISE EXCEPTION 'RENT_PLAN_NOT_ATTACHED_TO_SELF_SUPPORT_LINE';
    END IF;
    v_result := v_result || jsonb_build_object('step','rent_plan_attached_to_self_support_line','pass',true);

    v_stage := 'cfo_report_self_support_status';
    PERFORM set_config('request.jwt.claim.sub', v_agent::text, true);
    v_report := public.get_promissory_ops_report(now() - interval '1 hour', now() + interval '1 hour');
    SELECT n INTO v_self_report_note FROM jsonb_array_elements(v_report->'notes') AS n WHERE n->>'id' = v_self_note::text LIMIT 1;

    IF v_self_report_note IS NULL THEN RAISE EXCEPTION 'CFO_REPORT_NOTE_MISSING'; END IF;
    IF v_self_report_note->>'journey_stage' <> 'portfolio_pending' THEN RAISE EXCEPTION 'CFO_REPORT_STAGE_WRONG: %', v_self_report_note->>'journey_stage'; END IF;
    IF COALESCE((v_self_report_note->>'self_commitment_count')::int,0) <> 1 OR COALESCE((v_self_report_note->>'portfolio_count')::int,0) <> 1 OR COALESCE((v_self_report_note->>'portfolio_amount')::numeric,0) <> 100000 THEN
      RAISE EXCEPTION 'CFO_REPORT_SELF_SUPPORT_ROLLUP_WRONG';
    END IF;
    v_result := v_result || jsonb_build_object('step','cfo_report_shows_self_support_portfolio_pending','pass',true);

    v_stage := 'audit_event_visibility';
    SELECT count(*) INTO v_event_count FROM public.system_events WHERE event_type = 'promissory.self_support.portfolio_created' AND related_entity_id = v_self_note;
    IF v_event_count < 1 THEN RAISE EXCEPTION 'AUDIT_EVENT_MISSING'; END IF;
    v_result := v_result || jsonb_build_object('step','audit_event_written_for_cfo_trace','pass',true);

    RAISE EXCEPTION 'SMOKE_ROLLBACK' USING DETAIL = v_result::text;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'SMOKE_ROLLBACK' THEN
      RETURN jsonb_build_object('rolled_back', true, 'results', PG_EXCEPTION_DETAIL::jsonb);
    END IF;
    RETURN jsonb_build_object('rolled_back', true, 'pass', false, 'stage', v_stage, 'error', SQLERRM, 'results', v_result);
  END;
END;
$smoke$;

REVOKE ALL ON FUNCTION public.smoke_promissory_support_modes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smoke_promissory_support_modes() TO service_role;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sandbox_exec') THEN
    GRANT EXECUTE ON FUNCTION public.smoke_promissory_support_modes() TO sandbox_exec;
  END IF;
END
$grant$;
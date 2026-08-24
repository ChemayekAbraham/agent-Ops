CREATE OR REPLACE FUNCTION public.smoke_promissory_self_support()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  res jsonb := '[]'::jsonb;
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  p uuid := '00000000-0000-4000-8000-0000000000a2';
  t uuid := '00000000-0000-4000-8000-0000000000a3';
  l uuid := '00000000-0000-4000-8000-0000000000a4';
  ll uuid := '00000000-0000-4000-8000-0000000000a5';
  rr uuid := '00000000-0000-4000-8000-0000000000b1';
  nid uuid := '00000000-0000-4000-8000-0000000000c1';
  v jsonb;
  v_link uuid;
  v_detail text;
  stage text := 'start';
BEGIN
  BEGIN
    stage := 'insert_auth_users';
    INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
    SELECT x, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated',
           'pnsmoke-' || x::text || '@example.invalid', 'x', now(), now(), now(),
           jsonb_build_object('full_name', 'Smoke Test User')
    FROM unnest(ARRAY[a, p, t, l]) x;

    stage := 'insert_profiles';
    INSERT INTO public.profiles (id, full_name, phone) VALUES
      (a, 'Smoke Agent', '0700000901'),
      (t, 'Smoke Tenant', '0700000903'),
      (l, 'Smoke Landlord', '0700000904')
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone;

    stage := 'insert_landlord';
    INSERT INTO public.landlords (id, name, phone, property_address)
    VALUES (ll, 'Smoke Landlord', '0700000904', 'Smoke Test Road');

    stage := 'insert_rent_request';
    INSERT INTO public.rent_requests (id, tenant_id, landlord_id, rent_amount, duration_days, access_fee, request_fee, total_repayment, daily_repayment, status)
    VALUES (rr, t, ll, 300000, 30, 0, 0, 300000, 10000, 'pending');

    stage := 'insert_note';
    INSERT INTO public.promissory_notes (id, agent_id, partner_name, whatsapp_number, phone_number, amount, contribution_type, status, activation_token)
    VALUES (nid, a, 'Smoke Partner', '0700000902', '0700000902', 300000, 'one_time', 'pending', 'smoke-token-1');
    SELECT partner_user_id INTO v_link FROM public.promissory_notes WHERE id = nid;
    res := res || jsonb_build_object('step', '1_note_before_registration', 'partner_user_id', v_link, 'pass', v_link IS NULL);

    stage := 'insert_plan_intent';
    INSERT INTO public.promissory_note_plan_intents (note_id, rent_request_id, agent_id, amount, status)
    VALUES (nid, rr, a, 300000, 'reserved');
    res := res || jsonb_build_object('step', '2_plan_intent_reserved', 'pass',
      EXISTS (SELECT 1 FROM public.promissory_note_plan_intents WHERE note_id = nid AND rent_request_id = rr AND status = 'reserved'));

    stage := 'register_partner_profile';
    INSERT INTO public.profiles (id, full_name, phone) VALUES (p, 'Smoke Partner', '0700000902')
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone;
    SELECT partner_user_id INTO v_link FROM public.promissory_notes WHERE id = nid;
    res := res || jsonb_build_object('step', '3_autolink_on_registration', 'partner_user_id', v_link, 'pass', v_link = p);

    stage := 'context';
    v := public.promissory_self_support_context(p);
    res := res || jsonb_build_object('step', '4_context', 'value', v,
      'pass', (v->>'required')::boolean AND (v->>'plans')::int = 1 AND (v->>'amount')::numeric = 300000);

    stage := 'guard_partner';
    BEGIN
      PERFORM public.assert_no_promissory_self_support(p, 'smoke');
      res := res || jsonb_build_object('step', '5_guard_blocks_partner', 'pass', false, 'note', 'guard did not raise');
    EXCEPTION WHEN check_violation THEN
      res := res || jsonb_build_object('step', '5_guard_blocks_partner', 'pass', true, 'error', SQLERRM);
    END;

    stage := 'guard_unrelated';
    BEGIN
      PERFORM public.assert_no_promissory_self_support(t, 'smoke');
      res := res || jsonb_build_object('step', '6_guard_allows_unrelated', 'pass', true);
    EXCEPTION WHEN others THEN
      res := res || jsonb_build_object('step', '6_guard_allows_unrelated', 'pass', false, 'error', SQLERRM);
    END;

    stage := 'static_guard_check';
    res := res || jsonb_build_object('step', '7_rent_pool_paths_guarded', 'pass',
      (SELECT count(*) FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace
        WHERE n.nspname = 'public' AND pr.proname IN ('create_pending_portfolio','funder_create_pending_portfolio')
          AND pg_get_functiondef(pr.oid) ILIKE '%assert_no_promissory_self_support%') = 2);

    stage := 'tracker_view';
    res := res || jsonb_build_object('step', '8_cfo_tracker_row', 'value',
      (SELECT to_jsonb(x) FROM (SELECT note_id, partner_registered, reserved_plans, reserved_amount, funded_plans, routing_violation
         FROM public.v_promissory_self_support_tracker WHERE note_id = nid) x));

    stage := 'overloads';
    res := res || jsonb_build_object('step', '9_commitment_overloads',
      'count', (SELECT count(*) FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace
        WHERE n.nspname = 'public' AND pr.proname = 'psm_confirm_commitment_for'),
      'pass', (SELECT count(*) FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace
        WHERE n.nspname = 'public' AND pr.proname = 'psm_confirm_commitment_for') = 1);

    RAISE EXCEPTION 'SMOKE_ROLLBACK' USING DETAIL = res::text;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM = 'SMOKE_ROLLBACK' THEN
      RETURN jsonb_build_object('rolled_back', true, 'results', v_detail::jsonb);
    END IF;
    RETURN jsonb_build_object('rolled_back', true, 'failed_stage', stage, 'aborted_with', SQLERRM, 'results_so_far', res);
  END;
END;
$function$;
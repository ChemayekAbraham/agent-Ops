-- Tests for 20261019180000_rent_request_agent_chain.sql (rent_request_agent_chain). One transaction that always rolls back:
-- "ROLLED BACK REPORT: N passed of N | failing: none" is success. Nothing is kept. The parent rule is tested on throw-away agent_subagents rows
-- (verified / pending / expired / rejected links) created inside the transaction, against real profiles and a real rent request.
DO $test$
DECLARE
  r jsonb := '[]'::jsonb; v_U uuid; v_role text; v_ok boolean; v_res record; v_cnt bigint;
  v_req uuid; v_agent uuid; v_parent uuid; v_other uuid; v_assigned uuid; v_ids uuid[];
  v_st text;
BEGIN
  r := r || jsonb_build_object('step', 'A SECURITY DEFINER, STABLE, search_path = public, read-only; authenticated can execute, anon / service_role / PUBLIC cannot',
    'pass', (SELECT count(*) = 1 AND bool_and(p.prosecdef AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=public'] AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)
                AND p.prosrc !~* '\m(insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+temp)')
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'rent_request_agent_chain'));

  SELECT p.id INTO v_U FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) AND p.deleted_at IS NULL ORDER BY md5(p.id::text) LIMIT 1;
  SELECT array_agg(id) INTO v_ids FROM (SELECT id FROM public.rent_requests ORDER BY created_at DESC LIMIT 20) q;

  -- B. access
  FOREACH v_role IN ARRAY ARRAY['agent_ops', 'tenant_ops', 'landlord_ops', 'partner_ops', 'coo', 'cfo', 'ceo', 'cto', 'manager', 'super_admin', 'operations', 'financial_ops'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      SELECT count(*) INTO v_cnt FROM public.rent_request_agent_chain(v_ids);
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' can read the chain (20 ids, ' || v_cnt || ' rows)', 'pass', v_cnt = 20);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' can read the chain', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['agent', 'tenant', 'supporter', 'funder', 'service_center_manager'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      v_ok := false; BEGIN PERFORM 1 FROM public.rent_request_agent_chain(v_ids); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused (42501)', 'pass', v_ok);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN invalid_text_representation THEN
      NULL;  -- this role name does not exist in app_role: nothing to test
    WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' refused case ran', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;
  BEGIN
    INSERT INTO public.user_roles (user_id, role, enabled) VALUES (v_U, 'agent_ops'::public.app_role, false);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_ok := false; BEGIN PERFORM 1 FROM public.rent_request_agent_chain(v_ids); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    RESET ROLE;
    r := r || jsonb_build_object('step', 'B a switched-off desk role is refused', 'pass', v_ok);
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B disabled role case ran', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_ok := false; BEGIN PERFORM 1 FROM public.rent_request_agent_chain(v_ids); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
  RESET ROLE;
  r := r || jsonb_build_object('step', 'B a signed-in user with no role is refused', 'pass', v_ok);
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false; BEGIN PERFORM 1 FROM public.rent_request_agent_chain(v_ids); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'B signed-out is refused (42501)', 'pass', v_ok);
  BEGIN
    SET LOCAL ROLE anon;
    v_ok := false; BEGIN PERFORM 1 FROM public.rent_request_agent_chain(v_ids); EXCEPTION WHEN insufficient_privilege THEN v_ok := true; WHEN OTHERS THEN v_ok := false; END;
    RESET ROLE;
  END;
  r := r || jsonb_build_object('step', 'B the anon role cannot call it (permission denied)', 'pass', v_ok);

  INSERT INTO public.user_roles (user_id, role) VALUES (v_U, 'agent_ops'::public.app_role);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_ok := false; BEGIN PERFORM 1 FROM public.rent_request_agent_chain(ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 201))); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'TOO_MANY_IDS%'; END;
  SELECT count(*) INTO v_cnt FROM public.rent_request_agent_chain(ARRAY[gen_random_uuid(), NULL]::uuid[]);
  RESET ROLE;
  r := r || jsonb_build_object('step', 'C more than 200 ids is refused (TOO_MANY_IDS); unknown and null ids are simply left out', 'pass', v_ok AND v_cnt = 0);

  -- D. the parent rule, on throw-away links inside this transaction
  SELECT q.id, q.agent_id INTO v_req, v_agent FROM public.rent_requests q
   WHERE q.agent_id IS NOT NULL AND q.assigned_agent_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.agent_subagents s WHERE s.sub_agent_id = q.agent_id)
   ORDER BY q.created_at DESC LIMIT 1;
  SELECT p.id INTO v_parent FROM public.profiles p WHERE p.id <> v_agent AND p.full_name IS NOT NULL AND p.phone IS NOT NULL AND p.deleted_at IS NULL ORDER BY md5(p.id::text) LIMIT 1;
  SELECT p.id INTO v_other FROM public.profiles p WHERE p.id NOT IN (v_agent, v_parent) AND p.full_name IS NOT NULL AND p.phone IS NOT NULL AND p.deleted_at IS NULL ORDER BY md5(p.id::text || 'x') LIMIT 1;

  SET LOCAL ROLE authenticated;
  SELECT * INTO v_res FROM public.rent_request_agent_chain(ARRAY[v_req]);
  RESET ROLE;
  r := r || jsonb_build_object('step', 'D with no sub-agent link the request has no main agent and is not a sub-agent request; only the registering agent is returned',
    'pass', v_res.registering_agent_id = v_agent AND NOT v_res.is_verified_subagent AND v_res.parent_agent_id IS NULL AND v_res.parent_agent_name IS NULL AND NOT v_res.assigned_differs AND v_res.assigned_agent_id IS NULL);

  FOREACH v_st IN ARRAY ARRAY['pending_acceptance', 'expired', 'rejected'] LOOP
    BEGIN
      -- a new link is verified on insert by trg_auto_verify_subagent, so the other states are set afterwards (inside this rolled-back test)
      INSERT INTO public.agent_subagents (parent_agent_id, sub_agent_id, status) VALUES (v_parent, v_agent, 'verified');
      UPDATE public.agent_subagents SET status = v_st WHERE sub_agent_id = v_agent;
      SET LOCAL ROLE authenticated;
      SELECT * INTO v_res FROM public.rent_request_agent_chain(ARRAY[v_req]);
      RESET ROLE;
      r := r || jsonb_build_object('step', 'D a ' || v_st || ' link does not make a main agent', 'pass', NOT v_res.is_verified_subagent AND v_res.parent_agent_id IS NULL AND v_res.parent_agent_phone IS NULL);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'D ' || v_st || ' link case ran', 'pass', false, 'detail', left(SQLERRM, 250)); END IF;
    END;
  END LOOP;

  BEGIN
    INSERT INTO public.agent_subagents (parent_agent_id, sub_agent_id, status, verified_at) VALUES (v_parent, v_agent, 'verified', now());
    UPDATE public.agent_subagents SET status = 'verified', verified_at = now() WHERE sub_agent_id = v_agent;
    SET LOCAL ROLE authenticated;
    SELECT * INTO v_res FROM public.rent_request_agent_chain(ARRAY[v_req]);
    RESET ROLE;
    r := r || jsonb_build_object('step', 'D a verified link shows the main agent, with the main agent''s OWN name and phone, and the registering agent''s own phone',
      'pass', v_res.is_verified_subagent AND v_res.parent_agent_id = v_parent
          AND v_res.parent_agent_name IS NOT DISTINCT FROM (SELECT full_name FROM public.profiles WHERE id = v_parent) AND v_res.parent_agent_phone IS NOT DISTINCT FROM (SELECT phone FROM public.profiles WHERE id = v_parent)
          AND v_res.registering_agent_name IS NOT DISTINCT FROM (SELECT full_name FROM public.profiles WHERE id = v_agent) AND v_res.registering_agent_phone IS NOT DISTINCT FROM (SELECT phone FROM public.profiles WHERE id = v_agent));
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'D verified link case ran', 'pass', false, 'detail', left(SQLERRM, 250)); END IF;
  END;

  -- E. an assigned agent who is someone else (older requests; the database now refuses to create new ones): its own name and phone, never the registering agent's
  SELECT q.id, q.agent_id, q.assigned_agent_id INTO v_req, v_agent, v_assigned FROM public.rent_requests q
   WHERE q.assigned_agent_id IS NOT NULL AND q.assigned_agent_id IS DISTINCT FROM q.agent_id ORDER BY q.created_at DESC LIMIT 1;
  IF v_req IS NULL THEN
    r := r || jsonb_build_object('step', 'E a request whose assigned agent differs from the registering agent exists to test with', 'pass', false, 'detail', 'none found');
  ELSE
    SET LOCAL ROLE authenticated;
    SELECT * INTO v_res FROM public.rent_request_agent_chain(ARRAY[v_req]);
    RESET ROLE;
    r := r || jsonb_build_object('step', 'E an assigned agent who is someone else: assigned_differs, with the assigned agent''s own name and phone, and the registering agent''s own phone next to the registering name',
      'pass', v_res.assigned_differs AND v_res.assigned_agent_id = v_assigned
          AND v_res.assigned_agent_name IS NOT DISTINCT FROM (SELECT full_name FROM public.profiles WHERE id = v_assigned)
          AND v_res.assigned_agent_phone IS NOT DISTINCT FROM (SELECT phone FROM public.profiles WHERE id = v_assigned)
          AND v_res.registering_agent_id = v_agent
          AND v_res.registering_agent_name IS NOT DISTINCT FROM (SELECT full_name FROM public.profiles WHERE id = v_agent)
          AND v_res.registering_agent_phone IS NOT DISTINCT FROM (SELECT phone FROM public.profiles WHERE id = v_agent));
  END IF;
  SELECT q.id, q.agent_id INTO v_req, v_agent FROM public.rent_requests q WHERE q.assigned_agent_id = q.agent_id ORDER BY q.created_at DESC LIMIT 1;
  SET LOCAL ROLE authenticated;
  SELECT * INTO v_res FROM public.rent_request_agent_chain(ARRAY[v_req]);
  RESET ROLE;
  r := r || jsonb_build_object('step', 'E an assigned agent who is the registering agent is not "different"', 'pass', NOT v_res.assigned_differs AND v_res.assigned_agent_id = v_agent);

  -- F. every row equals the direct tables (live pass over real requests)
  SELECT array_agg(id) INTO v_ids FROM (SELECT id FROM public.rent_requests ORDER BY md5(id::text) LIMIT 200) q;
  SET LOCAL ROLE authenticated;
  CREATE TEMP TABLE zz_chain ON COMMIT DROP AS SELECT * FROM public.rent_request_agent_chain(v_ids);
  RESET ROLE;
  r := r || jsonb_build_object('step', 'F 200 real requests: one row each; the registering and assigned names and phones equal profiles; the main agent equals the earliest verified agent_subagents link (none when there is no verified link)',
    'pass', (SELECT count(*) FROM zz_chain) = 200
        AND NOT EXISTS (SELECT 1 FROM zz_chain c JOIN public.rent_requests q ON q.id = c.request_id LEFT JOIN public.profiles rp ON rp.id = q.agent_id LEFT JOIN public.profiles ap ON ap.id = q.assigned_agent_id
             WHERE c.registering_agent_id IS DISTINCT FROM q.agent_id OR c.registering_agent_name IS DISTINCT FROM rp.full_name OR c.registering_agent_phone IS DISTINCT FROM rp.phone
                OR c.assigned_agent_id IS DISTINCT FROM q.assigned_agent_id OR c.assigned_agent_name IS DISTINCT FROM ap.full_name OR c.assigned_agent_phone IS DISTINCT FROM ap.phone)
        AND NOT EXISTS (SELECT 1 FROM zz_chain c JOIN public.rent_requests q ON q.id = c.request_id
             WHERE c.parent_agent_id IS DISTINCT FROM (SELECT s.parent_agent_id FROM public.agent_subagents s WHERE s.sub_agent_id = q.agent_id AND s.status = 'verified' ORDER BY s.verified_at NULLS LAST, s.created_at LIMIT 1))
        AND NOT EXISTS (SELECT 1 FROM zz_chain c WHERE c.is_verified_subagent <> (c.parent_agent_id IS NOT NULL)),
    'detail', (SELECT count(*) FILTER (WHERE is_verified_subagent) || ' with a main agent, ' || count(*) FILTER (WHERE assigned_differs) || ' with a different assigned agent' FROM zz_chain));

  RAISE EXCEPTION 'ROLLED BACK REPORT: % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none');
END
$test$;

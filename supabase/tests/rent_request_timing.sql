-- Tests for 20261019100000_rent_request_timing.sql (rent_request_timing, rent_request_timing_history, _rt_compute, _rt_evidence).
-- One transaction that always rolls back: "ROLLED BACK REPORT: N passed of N | failing: none" is success. Nothing is written.
-- The logic is tested through _rt_compute at a FIXED server time (as_of = 2026-10-19 12:00:00 UTC) with hand-made evidence; the gatherer and the
-- access rules are tested against the deployed tables (read-only), and a live consistency pass checks real requests for impossible results.
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  T timestamptz := timestamptz '2026-10-19 12:00:00+00';
  d interval := interval '1 day';
  x jsonb; y jsonb; v_U uuid; v_role text; v_ok boolean; v_ids uuid[]; v_cnt bigint; v_vis_cnt bigint; v_res jsonb;
  function_src text;
BEGIN
  -- ---------- A. properties ----------
  r := r || jsonb_build_object('step', 'A the two public functions: SECURITY DEFINER, STABLE, search_path = public; authenticated only; read-only',
    'pass', (SELECT count(*) = 2 AND bool_and(p.prosecdef AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=public'] AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)
                AND p.prosrc !~* '\m(insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+temp|truncate)')
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('rent_request_timing', 'rent_request_timing_history')));
  r := r || jsonb_build_object('step', 'A the helpers cannot be executed by authenticated, anon, service_role or PUBLIC, and are read-only',
    'pass', (SELECT bool_and(NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)
                AND p.prosrc !~* '\m(insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+temp|truncate)')
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('_rt_compute', '_rt_evidence', '_rt_ts', '_rt_rank', '_rt_desk_of_status', '_rt_desk_name')));
  r := r || jsonb_build_object('step', 'A no ledger, wallet or payout table is read (only the landlord allocation lookup)',
    'pass', (SELECT bool_and(p.prosrc !~* '(general_ledger|wallet|landlord_payouts|payout_|agent_earnings)') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('_rt_compute', '_rt_evidence', 'rent_request_timing', 'rent_request_timing_history')));

  -- ---------- B. definitions at a fixed server time ----------
  -- 1. 3 days Agent Ops + 10 days Tenant Ops = current 10 days, previous 3 days, total 13 days
  x := public._rt_compute(jsonb_build_object('created_at', T - 13 * d, 'status', 'agent_ops_approved', 'sc_managed', false,
        'stamps', jsonb_build_object('agent_ops', T - 10 * d)), T);
  r := r || jsonb_build_object('step', 'B 3 days Agent Ops + 10 days Tenant Ops: current 10 days at tenant_ops, previous 3 days at agent_ops, total 13 days, confirmed',
    'pass', x->>'desk' = 'tenant_ops' AND (x#>>'{current,seconds}')::bigint = 864000 AND x#>>'{previous,desk}' = 'agent_ops' AND (x#>>'{previous,seconds}')::bigint = 259200
        AND (x->>'total_seconds')::bigint = 1123200 AND x->>'quality' = 'confirmed' AND x#>>'{current,quality}' = 'confirmed' AND x->>'as_of' IS NOT NULL, 'detail', x::text);

  -- 2. return / correction / resubmit resets only the new visit, keeps the total and the earlier visits
  x := public._rt_compute(jsonb_build_object('created_at', T - 20 * d, 'status', 'agent_ops_approved', 'sc_managed', false,
        'stamps', jsonb_build_object('agent_ops', T - 15 * d),
        'events', jsonb_build_array(jsonb_build_object('kind', 'returned', 't', T - 8 * d, 'stage', 'agent_ops_approved'),
                                    jsonb_build_object('kind', 'resubmitted', 't', T - 5 * d, 'to', 'agent_ops_approved'))), T, true);
  r := r || jsonb_build_object('step', 'B after a return, correction wait and resubmission: the new visit is 5 days, the previous visit is the 3-day correction wait, the total is still 20 days, and the earlier visits are kept',
    'pass', (x#>>'{current,seconds}')::bigint = 432000 AND x#>>'{current,source}' = 'resubmission' AND x#>>'{previous,desk}' = 'correction' AND (x#>>'{previous,seconds}')::bigint = 259200
        AND (x->>'total_seconds')::bigint = 1728000 AND jsonb_array_length(x->'visits') = 4
        AND (SELECT array_agg(v->>'desk' ORDER BY o) FROM jsonb_array_elements(x->'visits') WITH ORDINALITY t(v, o)) = ARRAY['agent_ops', 'tenant_ops', 'correction', 'tenant_ops']
        AND (SELECT array_agg((v->>'seconds')::bigint ORDER BY o) FROM jsonb_array_elements(x->'visits') WITH ORDINALITY t(v, o)) = ARRAY[432000::bigint, 604800, 259200, 432000],
    'detail', (x->'visits')::text);

  -- 3. waiting for the agent to correct: the correction wait is the current visit
  x := public._rt_compute(jsonb_build_object('created_at', T - 9 * d, 'status', 'rejected', 'sc_managed', false, 'rejected_at_stage', 'pending', 'returned_at', T - 2 * d,
        'stamps', jsonb_build_object()), T);
  r := r || jsonb_build_object('step', 'B a request returned to the agent: state correction, current 2 days with the agent, previous the agent_ops visit, total keeps running',
    'pass', x->>'state' = 'correction' AND x#>>'{current,desk}' = 'correction' AND (x#>>'{current,seconds}')::bigint = 172800 AND x#>>'{previous,desk}' = 'agent_ops'
        AND (x#>>'{previous,seconds}')::bigint = 604800 AND (x->>'total_seconds')::bigint = 777600, 'detail', x::text);

  -- 4. CFO returns to COO: stale earlier stamps are ignored for the current visit
  x := public._rt_compute(jsonb_build_object('created_at', T - 30 * d, 'status', 'partner_ops_approved', 'sc_managed', false,
        'stamps', jsonb_build_object('agent_ops', T - 28 * d, 'tenant_ops', T - 26 * d, 'landlord_ops', T - 24 * d, 'partner_ops', T - 22 * d, 'coo', T - 20 * d, 'cfo', T - 3 * d)), T);
  r := r || jsonb_build_object('step', 'B CFO-to-COO return: the current COO visit starts at the CFO stamp (3 days), not at the stale partner or COO stamps; labelled estimated; total 30 days',
    'pass', x->>'desk' = 'coo' AND (x#>>'{current,seconds}')::bigint = 259200 AND x#>>'{current,quality}' = 'estimated' AND x->>'quality' = 'estimated'
        AND x->'flags' @> to_jsonb('returned_from_later_desk_time_not_recorded'::text) AND (x->>'total_seconds')::bigint = 2592000, 'detail', x::text);

  -- 5. skipped Partner Ops has no invented visit
  x := public._rt_compute(jsonb_build_object('created_at', T - 12 * d, 'status', 'coo_approved', 'sc_managed', false,
        'stamps', jsonb_build_object('agent_ops', T - 9 * d, 'tenant_ops', T - 7 * d, 'landlord_ops', T - 5 * d, 'coo', T - 2 * d)), T, true);
  r := r || jsonb_build_object('step', 'B a skipped Partner Ops: listed as skipped, no visit of its own and no zero-length visit; the CFO desk has had the request 2 days',
    'pass', x->'skipped_desks' @> to_jsonb('partner_ops'::text) AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(x->'visits') v WHERE v->>'desk' = 'partner_ops')
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(x->'visits') v WHERE (v->>'seconds')::bigint = 0)
        AND x->>'desk' = 'cfo' AND (x#>>'{current,seconds}')::bigint = 172800 AND x#>>'{previous,desk}' = 'coo' AND (x#>>'{previous,seconds}')::bigint = 259200,
    'detail', (x->'visits')::text);

  -- 6. a renewal has a fresh clock
  x := public._rt_compute(jsonb_build_object('created_at', T - 1 * d, 'status', 'pending', 'sc_managed', false, 'registration_type', 'renewal', 'stamps', jsonb_build_object()), T);
  r := r || jsonb_build_object('step', 'B a renewal starts its own clock: current 1 day and total 1 day, nothing inherited from the earlier request, no previous visit',
    'pass', (x#>>'{current,seconds}')::bigint = 86400 AND (x->>'total_seconds')::bigint = 86400 AND x->'previous' IS NULL AND x->>'quality' = 'confirmed');

  -- 7. legacy agent_verified
  x := public._rt_compute(jsonb_build_object('created_at', T - 6 * d, 'status', 'agent_verified', 'sc_managed', false, 'stamps', jsonb_build_object('agent_ops', T - 4 * d)), T);
  r := r || jsonb_build_object('step', 'B legacy agent_verified is the Tenant Ops desk: 4 days there, previous 2 days at Agent Ops',
    'pass', x->>'desk' = 'tenant_ops' AND (x#>>'{current,seconds}')::bigint = 345600 AND x#>>'{previous,desk}' = 'agent_ops' AND (x#>>'{previous,seconds}')::bigint = 172800);

  -- 8. service-centre routes
  x := public._rt_compute(jsonb_build_object('created_at', T - 2 * d, 'status', 'service_center_review', 'sc_managed', true, 'stamps', jsonb_build_object()), T);
  y := public._rt_compute(jsonb_build_object('created_at', T - 2 * d, 'status', 'pending', 'sc_managed', true, 'stamps', jsonb_build_object('service_center', T - 1 * d),
        'events', jsonb_build_array(jsonb_build_object('kind', 'service_center_verified', 't', T - 1 * d))), T);
  r := r || jsonb_build_object('step', 'B service-centre route: waiting at the Service Centre 2 days; once verified the Agent Ops visit is 1 day and the previous visit is the Service Centre 1 day; one verification (event + stamp) is not counted twice',
    'pass', x->>'desk' = 'service_center' AND (x#>>'{current,seconds}')::bigint = 172800 AND x->'previous' IS NULL
        AND y->>'desk' = 'agent_ops' AND (y#>>'{current,seconds}')::bigint = 86400 AND y#>>'{previous,desk}' = 'service_center' AND (y#>>'{previous,seconds}')::bigint = 86400 AND y->>'quality' = 'confirmed');
  y := public._rt_compute(jsonb_build_object('created_at', T - 4 * d, 'status', 'pending', 'sc_managed', true, 'stamps', jsonb_build_object('service_center', T - 1 * d)), T);
  r := r || jsonb_build_object('step', 'B the Service Centre stamp stands in for a missing verification event (older requests)',
    'pass', y->>'desk' = 'agent_ops' AND (y#>>'{current,seconds}')::bigint = 86400 AND y#>>'{previous,desk}' = 'service_center' AND (y#>>'{previous,seconds}')::bigint = 259200);
  y := public._rt_compute(jsonb_build_object('created_at', T - 4 * d, 'status', 'pending', 'sc_managed', true, 'stamps', jsonb_build_object()), T);
  r := r || jsonb_build_object('step', 'B Service Centre route with no verification time at all: unavailable with a reason, never a guess',
    'pass', y->>'quality' = 'unavailable' AND y->'current' IS NULL AND y->>'missing_reason' = 'service_center_verification_time_not_recorded');
  y := public._rt_compute(jsonb_build_object('created_at', T - 5 * d, 'status', 'rejected', 'sc_managed', true, 'rejected_at', T - 3 * d, 'stamps', jsonb_build_object()), T);
  r := r || jsonb_build_object('step', 'B rejected at the Service Centre: ended, the total is frozen at the rejection (2 days), no current visit',
    'pass', y->>'state' = 'ended' AND (y->>'total_seconds')::bigint = 172800 AND y->'current' IS NULL AND y#>>'{previous,desk}' = 'service_center');

  -- 9. outstanding registration bypass: desks with no stamp are skipped, nothing invented
  x := public._rt_compute(jsonb_build_object('created_at', T - 3 * d, 'status', 'coo_approved', 'sc_managed', false, 'registration_type', 'outstanding_balance', 'stamps', jsonb_build_object()), T, true);
  r := r || jsonb_build_object('step', 'B outstanding-registration bypass: only the first and last desk have visits; the bypassed desks are skipped, and the time is an estimate',
    'pass', x->>'desk' = 'cfo' AND x->>'quality' = 'estimated' AND jsonb_array_length(x->'skipped_desks') >= 3
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(x->'visits') v WHERE (v->>'seconds')::bigint = 0), 'detail', x::text);

  -- 10. force approval and reopen
  x := public._rt_compute(jsonb_build_object('created_at', T - 10 * d, 'status', 'coo_approved', 'sc_managed', false,
        'stamps', jsonb_build_object('agent_ops', T - 8 * d, 'tenant_ops', T - 6 * d, 'landlord_ops', T - 4 * d),
        'events', jsonb_build_array(jsonb_build_object('kind', 'force_approved', 't', T - 1 * d, 'to', 'coo_approved'))), T);
  r := r || jsonb_build_object('step', 'B force approval: the CFO desk visit starts at the force-approval event (1 day) and says so',
    'pass', x->>'desk' = 'cfo' AND (x#>>'{current,seconds}')::bigint = 86400 AND x#>>'{current,source}' = 'force_approval' AND x#>>'{current,quality}' = 'confirmed');
  x := public._rt_compute(jsonb_build_object('created_at', T - 10 * d, 'status', 'agent_ops_approved', 'sc_managed', false, 'stamps', jsonb_build_object('agent_ops', T - 6 * d),
        'events', jsonb_build_array(jsonb_build_object('kind', 'returned', 't', T - 4 * d, 'stage', 'agent_ops_approved'), jsonb_build_object('kind', 'resubmitted', 't', T - 1 * d, 'to', 'agent_ops_approved'))), T, true);
  r := r || jsonb_build_object('step', 'B reopen after correction: the Tenant Ops visit restarts at the resubmission (1 day); the earlier Tenant Ops visit stays as its own visit',
    'pass', (x#>>'{current,seconds}')::bigint = 86400 AND (SELECT count(*) FROM jsonb_array_elements(x->'visits') v WHERE v->>'desk' = 'tenant_ops') = 2);

  -- 11. missing, duplicated, future and conflicting timestamps
  x := public._rt_compute(jsonb_build_object('created_at', T - 10 * d, 'status', 'tenant_ops_approved', 'sc_managed', false, 'stamps', jsonb_build_object()), T);
  r := r || jsonb_build_object('step', 'B no stamps at all for a request that sits at Landlord Ops: the entry is a skipped-desk fallback labelled estimated, never a zero or an invented stamp',
    'pass', x->>'desk' = 'landlord_ops' AND x#>>'{current,quality}' = 'estimated' AND x->>'quality' = 'estimated');
  x := public._rt_compute(jsonb_build_object('created_at', NULL, 'status', 'pending', 'stamps', jsonb_build_object()), T);
  r := r || jsonb_build_object('step', 'B a missing created_at is unavailable with a reason (never zero)', 'pass', x->>'quality' = 'unavailable' AND x->>'missing_reason' = 'created_at_missing_or_in_the_future' AND x->'total_seconds' IS NULL);
  x := public._rt_compute(jsonb_build_object('created_at', T - 10 * d, 'status', 'agent_ops_approved', 'sc_managed', false,
        'stamps', jsonb_build_object('agent_ops', T - 5 * d),
        'events', jsonb_build_array(jsonb_build_object('kind', 'returned', 't', T - 4 * d, 'stage', 'agent_ops_approved'), jsonb_build_object('kind', 'returned', 't', T - 4 * d + interval '1 second', 'stage', 'agent_ops_approved'),
                                    jsonb_build_object('kind', 'resubmitted', 't', T - 2 * d, 'to', 'agent_ops_approved'), jsonb_build_object('kind', 'resubmitted', 't', T - 2 * d, 'to', 'agent_ops_approved'))), T, true);
  r := r || jsonb_build_object('step', 'B duplicated representations of one transition (a return twice a second apart, a resubmission twice at the same instant) count once',
    'pass', (x->>'review_returns_recorded')::int = 1 AND (SELECT count(*) FROM jsonb_array_elements(x->'visits') v WHERE v->>'desk' = 'correction') = 1 AND (x#>>'{previous,seconds}')::bigint = 172800);
  x := public._rt_compute(jsonb_build_object('created_at', T - 10 * d, 'status', 'agent_ops_approved', 'sc_managed', false, 'stamps', jsonb_build_object('agent_ops', T + 2 * d)), T);
  r := r || jsonb_build_object('step', 'B a stamp in the future is set aside and flagged: the current visit is an estimate or unavailable, never negative',
    'pass', x->'flags' @> to_jsonb('future_stamp:agent_ops'::text) AND x->>'quality' IN ('estimated', 'unavailable') AND COALESCE((x#>>'{current,seconds}')::bigint, 0) >= 0);
  x := public._rt_compute(jsonb_build_object('created_at', T - 10 * d, 'status', 'agent_ops_approved', 'sc_managed', false, 'stamps', jsonb_build_object('agent_ops', T - 11 * d)), T);
  r := r || jsonb_build_object('step', 'B a stamp before creation (inverted) is set aside and flagged', 'pass', x->'flags' @> to_jsonb('inverted_stamp:agent_ops'::text) AND x->>'quality' IN ('estimated', 'unavailable'));
  x := public._rt_compute(jsonb_build_object('created_at', T - 12 * d, 'status', 'landlord_ops_approved', 'sc_managed', false,
        'stamps', jsonb_build_object('agent_ops', T - 5 * d, 'tenant_ops', T - 7 * d, 'landlord_ops', T - 3 * d)), T);
  r := r || jsonb_build_object('step', 'B conflicting stamps (Tenant Ops approved before Agent Ops) are flagged and the answer is an estimate',
    'pass', EXISTS (SELECT 1 FROM jsonb_array_elements_text(x->'flags') f WHERE f LIKE 'conflicting_order:%') AND x->>'quality' = 'estimated');

  -- 12. funding vs landlord receipt vs repayment completion
  x := public._rt_compute(jsonb_build_object('created_at', T - 20 * d, 'status', 'repaying', 'sc_managed', false, 'funded_at', T - 10 * d, 'landlord_paid_at', T - 4 * d,
        'stamps', jsonb_build_object('agent_ops', T - 18 * d, 'tenant_ops', T - 16 * d, 'landlord_ops', T - 14 * d, 'partner_ops', T - 12 * d, 'coo', T - 11 * d)), T);
  r := r || jsonb_build_object('step', 'B funded, landlord paid, repaying: the review clock is frozen at funding (total 10 days) and the payout wait (funded to landlord paid, 6 days) is separate and labelled approximate; repayment completion has no time',
    'pass', x->>'state' = 'processed' AND (x->>'total_seconds')::bigint = 864000 AND (x#>>'{payout,waiting_seconds}')::bigint = 518400 AND (x#>>'{payout,still_waiting}')::boolean = false
        AND x#>>'{payout,landlord_paid_quality}' = 'estimated' AND x#>'{payout,repayment_completed_at}' IS NULL AND x->'current' IS NULL, 'detail', (x->'payout')::text);
  y := public._rt_compute(jsonb_build_object('created_at', T - 20 * d, 'status', 'funded', 'sc_managed', false, 'funded_at', T - 3 * d,
        'stamps', jsonb_build_object('agent_ops', T - 18 * d, 'tenant_ops', T - 16 * d, 'landlord_ops', T - 14 * d, 'partner_ops', T - 12 * d, 'coo', T - 11 * d)), T);
  r := r || jsonb_build_object('step', 'B funded but the landlord not paid yet: the payout wait is still running (3 days) and the review total stays frozen at 17 days',
    'pass', (y#>>'{payout,still_waiting}')::boolean AND (y#>>'{payout,waiting_seconds}')::bigint = 259200 AND (y->>'total_seconds')::bigint = 1468800);
  y := public._rt_compute(jsonb_build_object('created_at', T - 20 * d, 'status', 'completed', 'sc_managed', false, 'funded_at', T - 10 * d, 'landlord_paid_at', T - 4 * d, 'stamps', jsonb_build_object('coo', T - 11 * d)), T);
  r := r || jsonb_build_object('step', 'B a completed plan does not stretch the review clock: the total is still frozen at funding (10 days)', 'pass', (y->>'total_seconds')::bigint = 864000);
  y := public._rt_compute(jsonb_build_object('created_at', T - 8 * d, 'status', 'deleted_by_agent', 'sc_managed', false, 'stamps', jsonb_build_object('agent_ops', T - 6 * d),
        'events', jsonb_build_array(jsonb_build_object('kind', 'deleted', 't', T - 5 * d))), T);
  r := r || jsonb_build_object('step', 'B a withdrawn request is frozen at the withdrawal (3 days)', 'pass', y->>'state' = 'ended' AND (y->>'total_seconds')::bigint = 259200);
  y := public._rt_compute(jsonb_build_object('created_at', T - 8 * d, 'status', 'cancelled', 'sc_managed', false, 'stamps', jsonb_build_object()), T);
  r := r || jsonb_build_object('step', 'B a cancelled request with no recorded cancellation time has no total (unavailable), not a guess', 'pass', y->>'quality' = 'unavailable' AND y->'total_seconds' IS NULL AND y->>'missing_reason' = 'processing_endpoint_not_recorded');

  -- ---------- C. access and the gatherer (deployed tables, read-only) ----------
  SELECT p.id INTO v_U FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) AND p.deleted_at IS NULL
     ORDER BY md5(p.id::text) LIMIT 1;
  SELECT array_agg(id) INTO v_ids FROM (SELECT id FROM public.rent_requests ORDER BY created_at DESC LIMIT 60) q;

  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false; BEGIN PERFORM public.rent_request_timing(v_ids); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'C signed-out is refused (42501) by the batch and by the history function', 'pass', v_ok AND (SELECT NOT has_function_privilege('anon', 'public.rent_request_timing(uuid[])'::regprocedure, 'EXECUTE')));
  v_ok := false; BEGIN PERFORM public.rent_request_timing_history(v_ids[1]); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'C the history function refuses a signed-out caller too', 'pass', v_ok);
  BEGIN
    SET LOCAL ROLE anon;
    v_ok := false; BEGIN PERFORM public.rent_request_timing(v_ids); EXCEPTION WHEN insufficient_privilege THEN v_ok := true; WHEN OTHERS THEN v_ok := false; END;
    RESET ROLE;
  END;
  r := r || jsonb_build_object('step', 'C the anon role cannot call it (permission denied)', 'pass', v_ok);

  -- a user with no role and no request of their own sees none of the ids (unauthorised ids are left out, not revealed)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := public.rent_request_timing(v_ids);
  SELECT count(*) INTO v_vis_cnt FROM public.rent_requests WHERE id = ANY (v_ids);
  RESET ROLE;
  r := r || jsonb_build_object('step', 'C a signed-in user with no role: of 60 ids only the ones row-level security lets them read come back (their own, if any); the others are left out, not revealed',
    'pass', (v_res->>'requested')::int = 60 AND (v_res->>'returned')::int = v_vis_cnt AND (v_res->>'returned')::int < 60 AND jsonb_array_length(v_res->'rows') = v_vis_cnt, 'detail', (v_res->>'returned') || ' vs ' || v_vis_cnt);
  SET LOCAL ROLE authenticated;
  v_ok := false; BEGIN PERFORM public.rent_request_timing(ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 201))); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'TOO_MANY_IDS%'; END;
  RESET ROLE;
  r := r || jsonb_build_object('step', 'C more than 200 ids is refused (TOO_MANY_IDS)', 'pass', v_ok);

  FOREACH v_role IN ARRAY ARRAY['agent_ops', 'tenant_ops', 'landlord_ops', 'coo', 'cfo', 'ceo', 'manager', 'super_admin'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      v_res := public.rent_request_timing(v_ids);
      SELECT count(*) INTO v_vis_cnt FROM public.rent_requests WHERE id = ANY (v_ids);   -- what RLS lets this role read
      RESET ROLE;
      r := r || jsonb_build_object('step', 'C ' || v_role || ': the requests timed equal the requests row-level security lets this role read (' || v_vis_cnt || ' of 60)',
        'pass', (v_res->>'returned')::int = v_vis_cnt AND (v_res->>'as_of') IS NOT NULL, 'detail', (v_res->>'returned') || ' vs ' || v_vis_cnt);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'C ' || v_role || ' visibility case ran', 'pass', false, 'detail', left(SQLERRM, 250)); END IF;
    END;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['partner_ops', 'financial_ops', 'operations', 'agent', 'tenant'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      v_res := public.rent_request_timing(v_ids);
      SELECT count(*) INTO v_vis_cnt FROM public.rent_requests WHERE id = ANY (v_ids);
      RESET ROLE;
      r := r || jsonb_build_object('step', 'C ' || v_role || ': never sees more than row-level security allows (' || v_vis_cnt || ')', 'pass', (v_res->>'returned')::int <= v_vis_cnt, 'detail', (v_res->>'returned') || ' vs ' || v_vis_cnt);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'C ' || v_role || ' visibility case ran', 'pass', false, 'detail', left(SQLERRM, 250)); END IF;
    END;
  END LOOP;

  -- an agent sees the timing of their own request and nothing of other agents' requests
  BEGIN
    SELECT q.agent_id INTO v_U FROM public.rent_requests q WHERE q.agent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = q.agent_id AND ur.role::text IN ('manager', 'cfo', 'coo', 'ceo', 'agent_ops', 'landlord_ops', 'super_admin', 'tenant_ops'))
       GROUP BY q.agent_id ORDER BY count(*) DESC LIMIT 1;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_res := public.rent_request_timing(v_ids);
    SELECT count(*) INTO v_vis_cnt FROM public.rent_requests WHERE id = ANY (v_ids);
    RESET ROLE;
    r := r || jsonb_build_object('step', 'C an agent: the timed set is exactly the set row-level security gives them (their own requests plus unverified pending ones to verify)',
      'pass', (v_res->>'returned')::int = v_vis_cnt AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_res->'rows') e WHERE NOT EXISTS (SELECT 1 FROM public.rent_requests q WHERE q.id = (e->>'request_id')::uuid
          AND (q.agent_id = v_U OR q.tenant_id = v_U OR (q.agent_verified = false AND q.status IN ('pending', 'approved'))))), 'detail', (v_res->>'returned') || ' vs ' || v_vis_cnt);
  EXCEPTION WHEN OTHERS THEN
    r := r || jsonb_build_object('step', 'C agent visibility case ran', 'pass', false, 'detail', left(SQLERRM, 250));
  END;

  -- ---------- D. a live pass over real requests: nothing impossible ----------
  SELECT p.id INTO v_U FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) AND p.deleted_at IS NULL ORDER BY md5(p.id::text) LIMIT 1;
  INSERT INTO public.user_roles (user_id, role) VALUES (v_U, 'super_admin'::public.app_role);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
  SELECT array_agg(id) INTO v_ids FROM (SELECT id FROM public.rent_requests ORDER BY md5(id::text) LIMIT 200) q;
  SET LOCAL ROLE authenticated;
  v_res := public.rent_request_timing(v_ids);
  RESET ROLE;
  r := r || jsonb_build_object('step', 'D 200 real requests answered in one call, one as_of, each row has a request id, a state and a quality',
    'pass', (v_res->>'returned')::int = 200 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'rows') e WHERE e->>'request_id' IS NULL OR e->>'state' IS NULL OR e->>'quality' NOT IN ('confirmed', 'estimated', 'unavailable')),
    'detail', (v_res->>'returned'));
  r := r || jsonb_build_object('step', 'D no negative duration anywhere (current, previous, total, payout wait)',
    'pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'rows') e WHERE COALESCE((e#>>'{current,seconds}')::numeric, 0) < 0 OR COALESCE((e#>>'{previous,seconds}')::numeric, 0) < 0
        OR COALESCE((e->>'total_seconds')::numeric, 0) < 0 OR COALESCE((e#>>'{payout,waiting_seconds}')::numeric, 0) < 0));
  r := r || jsonb_build_object('step', 'D the current visit is never longer than the total, and never started before the request did',
    'pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'rows') e WHERE (e#>>'{current,seconds}') IS NOT NULL AND (e->>'total_seconds') IS NOT NULL AND (e#>>'{current,seconds}')::numeric > (e->>'total_seconds')::numeric)
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'rows') e WHERE (e#>>'{current,entry}') IS NOT NULL AND (e#>>'{current,entry}')::timestamptz < (e->>'request_start')::timestamptz));
  r := r || jsonb_build_object('step', 'D previous visit + current visit never exceed the total; an open request has no processing end; a processed request has no current visit',
    'pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'rows') e WHERE (e#>>'{current,seconds}') IS NOT NULL AND (e#>>'{previous,seconds}') IS NOT NULL AND (e->>'total_seconds') IS NOT NULL
          AND (e#>>'{current,seconds}')::numeric + (e#>>'{previous,seconds}')::numeric > (e->>'total_seconds')::numeric + 1)
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'rows') e WHERE e->>'state' IN ('processed', 'ended') AND e->'current' IS NOT NULL));
  r := r || jsonb_build_object('step', 'D every open request (at a desk or in correction) matches the status it has: the desk named is the desk of its status',
    'pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'rows') e JOIN public.rent_requests q ON q.id = (e->>'request_id')::uuid
        WHERE e->>'state' = 'at_desk' AND e->>'desk' IS DISTINCT FROM public._rt_desk_of_status(q.status)));
  SET LOCAL ROLE authenticated;
  y := public.rent_request_timing_history((v_res->'rows'->0->>'request_id')::uuid);
  RESET ROLE;
  r := r || jsonb_build_object('step', 'D the history of one request agrees with its batch row (same state and quality) and carries the visits and the events on demand',
    'pass', y->>'state' = v_res->'rows'->0->>'state' AND y->>'quality' = v_res->'rows'->0->>'quality' AND y->'visits' IS NOT NULL AND y->'events' IS NOT NULL);

  RAISE EXCEPTION 'ROLLED BACK REPORT: % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none');
END
$test$;

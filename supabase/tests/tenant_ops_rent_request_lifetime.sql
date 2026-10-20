-- Tests for 20261016200000_tenant_ops_rent_request_lifetime.sql (tenant_ops_rent_request_lifetime).
-- One transaction that always rolls back; "ROLLED BACK REPORT: N passed of N | failing: none" is success.
-- Every figure is recomputed straight from rent_requests / agent_landlord_float_allocations in a different way and compared.
DO $test$
DECLARE
  r jsonb := '[]'::jsonb; v_U uuid; v_role text; v_ok boolean; j jsonb;
  v_sub bigint; v_fund bigint; v_fin bigint; v_full bigint; v_part bigint; v_never bigint; v_early bigint; v_closed bigint; v_fnf bigint; v_tot numeric; v_rep numeric;
BEGIN
  r := r || jsonb_build_object('step', 'A exists, SECURITY DEFINER, STABLE, search_path = public, jsonb, no arguments',
    'pass', (SELECT count(*) = 1 AND bool_and(p.prosecdef AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=public'] AND p.prorettype = 'jsonb'::regtype AND p.pronargs = 0)
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'tenant_ops_rent_request_lifetime'));
  r := r || jsonb_build_object('step', 'A authenticated can execute; anon, service_role and PUBLIC cannot',
    'pass', (SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                     AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'tenant_ops_rent_request_lifetime'));
  r := r || jsonb_build_object('step', 'A read-only (no write statements) and no date parameter',
    'pass', (SELECT p.prosrc !~* '\m(insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+temp)' FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'tenant_ops_rent_request_lifetime'));

  SELECT p.id INTO v_U FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) AND p.deleted_at IS NULL ORDER BY md5(p.id::text) LIMIT 1;
  FOREACH v_role IN ARRAY ARRAY['operations', 'manager', 'super_admin', 'coo', 'ceo', 'cto'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      j := public.tenant_ops_rent_request_lifetime();
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' can read it', 'pass', (j->>'submitted')::bigint > 0);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' can read it', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['tenant_ops', 'landlord_ops', 'agent_ops', 'cfo', 'financial_ops', 'partner_ops', 'agent', 'tenant'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      v_ok := false; BEGIN PERFORM public.tenant_ops_rent_request_lifetime(); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused (42501), as by ops_tenant_ops_home_range', 'pass', v_ok);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;
  BEGIN
    INSERT INTO public.user_roles (user_id, role, enabled) VALUES (v_U, 'operations'::public.app_role, false);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_ok := false; BEGIN PERFORM public.tenant_ops_rent_request_lifetime(); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    RESET ROLE;
    r := r || jsonb_build_object('step', 'B a switched-off operations role is refused', 'pass', v_ok);
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B disabled role case ran', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false; BEGIN PERFORM public.tenant_ops_rent_request_lifetime(); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'B signed-out is refused (42501)', 'pass', v_ok);
  BEGIN
    SET LOCAL ROLE anon;
    v_ok := false; BEGIN PERFORM public.tenant_ops_rent_request_lifetime(); EXCEPTION WHEN insufficient_privilege THEN v_ok := true; WHEN OTHERS THEN v_ok := false; END;
    RESET ROLE;
  END;
  r := r || jsonb_build_object('step', 'B the anon role cannot call it (permission denied)', 'pass', v_ok);

  INSERT INTO public.user_roles (user_id, role) VALUES (v_U, 'operations'::public.app_role);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  j := public.tenant_ops_rent_request_lifetime();
  RESET ROLE;

  -- direct recompute
  CREATE TEMP TABLE zz_fin ON COMMIT DROP AS
    SELECT q.id, q.status, COALESCE(q.amount_repaid, 0) AS repaid, COALESCE(q.total_repayment, 0) AS total, x.paid_at
      FROM public.rent_requests q
      JOIN (SELECT a.rent_request_id, min(a.updated_at) AS paid_at FROM public.agent_landlord_float_allocations a
             WHERE a.status <> 'cancelled' AND a.paid_out_amount > 0 GROUP BY a.rent_request_id) x ON x.rent_request_id = q.id;
  SELECT count(*) INTO v_sub FROM public.rent_requests;
  SELECT count(*) INTO v_fund FROM public.rent_requests WHERE funded_at IS NOT NULL;
  SELECT count(*), count(*) FILTER (WHERE status = 'completed' OR (total > 0 AND repaid >= total)),
         count(*) FILTER (WHERE NOT (status = 'completed' OR (total > 0 AND repaid >= total)) AND repaid > 0),
         count(*) FILTER (WHERE NOT (status = 'completed' OR (total > 0 AND repaid >= total)) AND repaid = 0 AND paid_at < now() - interval '30 days'),
         count(*) FILTER (WHERE NOT (status = 'completed' OR (total > 0 AND repaid >= total)) AND repaid = 0 AND paid_at >= now() - interval '30 days'),
         count(*) FILTER (WHERE status IN ('rejected', 'cancelled', 'deleted_by_agent')), COALESCE(sum(total), 0), COALESCE(sum(repaid), 0)
    INTO v_fin, v_full, v_part, v_never, v_early, v_closed, v_tot, v_rep FROM zz_fin;
  SELECT count(*) INTO v_fnf FROM public.rent_requests q WHERE q.funded_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM zz_fin f WHERE f.id = q.id);

  r := r || jsonb_build_object('step', 'C submitted, funded, financed equal the direct counts',
    'pass', (j->>'submitted')::bigint = v_sub AND (j->>'funded')::bigint = v_fund AND (j->>'financed')::bigint = v_fin,
    'detail', json_build_object('submitted', j->>'submitted', 'funded', j->>'funded', 'financed', j->>'financed')::text);
  r := r || jsonb_build_object('step', 'C the four repayment buckets equal the direct counts and add up to financed',
    'pass', (j#>>'{repayment,full}')::bigint = v_full AND (j#>>'{repayment,partial}')::bigint = v_part AND (j#>>'{repayment,never_paid}')::bigint = v_never AND (j#>>'{repayment,too_early}')::bigint = v_early
        AND v_full + v_part + v_never + v_early = v_fin
        AND (j#>>'{repayment,full}')::bigint + (j#>>'{repayment,partial}')::bigint + (j#>>'{repayment,never_paid}')::bigint + (j#>>'{repayment,too_early}')::bigint = (j->>'financed')::bigint,
    'detail', (j->'repayment')::text);
  r := r || jsonb_build_object('step', 'C financed_now_closed, funded_not_financed and the money equal the direct figures',
    'pass', (j->>'financed_now_closed')::bigint = v_closed AND (j->>'funded_not_financed')::bigint = v_fnf
        AND (j#>>'{money,total_repayment}')::numeric = v_tot AND (j#>>'{money,amount_repaid}')::numeric = v_rep,
    'detail', (j->>'financed_now_closed') || ' ' || (j->>'funded_not_financed') || ' ' || (j#>>'{money,total_repayment}') || ' ' || (j#>>'{money,amount_repaid}'));
  r := r || jsonb_build_object('step', 'C outcomes equal the direct status counts',
    'pass', (j#>>'{outcomes,waiting_service_centre}')::bigint = (SELECT count(*) FROM public.rent_requests WHERE status = 'service_center_review')
        AND (j#>>'{outcomes,pending}')::bigint = (SELECT count(*) FROM public.rent_requests WHERE status = 'pending')
        AND (j#>>'{outcomes,rejected}')::bigint = (SELECT count(*) FROM public.rent_requests WHERE status = 'rejected')
        AND (j#>>'{outcomes,deleted_by_agent}')::bigint = (SELECT count(*) FROM public.rent_requests WHERE status = 'deleted_by_agent')
        AND (j#>>'{outcomes,cancelled}')::bigint = (SELECT count(*) FROM public.rent_requests WHERE status = 'cancelled'));
  r := r || jsonb_build_object('step', 'C funnel: eight rows in pipeline order, never rising, financed row equals financed, funded row is funded (plus any financed request with no funded_at)',
    'pass', (SELECT array_agg(e->>'stage' ORDER BY o) FROM jsonb_array_elements(j->'stage_funnel') WITH ORDINALITY t(e, o)) = ARRAY['service_center', 'agent_ops', 'tenant_ops', 'landlord_ops', 'partner_ops', 'coo', 'funded', 'financed']
        AND (SELECT bool_and((e->>'count')::bigint <= COALESCE(lag_v, (e->>'count')::bigint)) FROM (SELECT e, lag((e->>'count')::bigint) OVER () AS lag_v FROM jsonb_array_elements(j->'stage_funnel') e) z(e, lag_v))
        AND (j->'stage_funnel'->7->>'count')::bigint = v_fin
        AND (j->'stage_funnel'->6->>'count')::bigint = v_fund + (SELECT count(*) FROM zz_fin f JOIN public.rent_requests q ON q.id = f.id WHERE q.funded_at IS NULL)
        AND (j->'stage_funnel'->0->>'count')::bigint <= v_sub,
    'detail', (j->'stage_funnel')::text);
  r := r || jsonb_build_object('step', 'C funnel rows from the status order: pending and later clear the Service Centre; a request at service_center_review clears nothing',
    'pass', (j->'stage_funnel'->0->>'count')::bigint >= (SELECT count(*) FROM public.rent_requests WHERE status IN ('pending', 'agent_ops_approved', 'tenant_ops_approved', 'landlord_ops_approved', 'partner_ops_approved', 'coo_approved', 'funded', 'repaying', 'completed'))
        AND (j->'stage_funnel'->0->>'count')::bigint <= v_sub - (SELECT count(*) FROM public.rent_requests WHERE status = 'service_center_review'));
  r := r || jsonb_build_object('step', 'C a *_reviewed_at alone is not an approval: active requests are placed by status only (no active request moves up on a review stamp)',
    'pass', (j->'stage_funnel'->2->>'count')::bigint = (SELECT count(*) FROM public.rent_requests q WHERE
          (q.status IN ('tenant_ops_approved', 'landlord_ops_approved', 'partner_ops_approved', 'coo_approved', 'funded', 'repaying', 'completed')
           OR q.funded_at IS NOT NULL OR q.id IN (SELECT id FROM zz_fin)
           OR (q.status IN ('rejected', 'cancelled', 'deleted_by_agent') AND GREATEST(
                 CASE WHEN q.service_center_reviewed_at IS NOT NULL THEN 1 ELSE 0 END, CASE WHEN q.agent_ops_reviewed_at IS NOT NULL THEN 2 ELSE 0 END,
                 CASE WHEN q.tenant_ops_reviewed_at IS NOT NULL THEN 3 ELSE 0 END, CASE WHEN q.landlord_ops_reviewed_at IS NOT NULL THEN 4 ELSE 0 END,
                 CASE WHEN q.partner_ops_reviewed_at IS NOT NULL THEN 5 ELSE 0 END, CASE WHEN q.coo_reviewed_at IS NOT NULL THEN 6 ELSE 0 END) - 1 >= 3))));

  -- D. the 30-day boundary, by simulation inside this rolled-back test: one never-paid request (paid 40+ days ago) moved to 29 days ago becomes too early
  DECLARE v_alloc uuid; v_rid uuid; v_got timestamptz; j29 jsonb;
  BEGIN
    SELECT a.id, a.rent_request_id INTO v_alloc, v_rid FROM public.agent_landlord_float_allocations a JOIN public.rent_requests q ON q.id = a.rent_request_id
     WHERE a.status <> 'cancelled' AND a.paid_out_amount > 0 AND COALESCE(q.amount_repaid, 0) = 0 AND q.status <> 'completed' AND NOT (COALESCE(q.total_repayment, 0) > 0 AND 0 >= q.total_repayment)
       AND a.updated_at < now() - interval '40 days'
       AND NOT EXISTS (SELECT 1 FROM public.agent_landlord_float_allocations b WHERE b.rent_request_id = a.rent_request_id AND b.id <> a.id AND b.status <> 'cancelled' AND b.paid_out_amount > 0)
     ORDER BY a.updated_at LIMIT 1;
    IF v_alloc IS NULL THEN
      r := r || jsonb_build_object('step', 'D boundary: a never-paid request to simulate with', 'pass', false, 'detail', 'none found');
    ELSE
      UPDATE public.agent_landlord_float_allocations SET updated_at = now() - interval '29 days' WHERE id = v_alloc;
      SELECT updated_at INTO v_got FROM public.agent_landlord_float_allocations WHERE id = v_alloc;
      IF v_got > now() - interval '30 days' THEN
        SET LOCAL ROLE authenticated; j29 := public.tenant_ops_rent_request_lifetime(); RESET ROLE;
        r := r || jsonb_build_object('step', 'D a never-paid request (landlord paid 40+ days ago) moved to 29 days ago becomes too early; the buckets still add up to financed',
          'pass', (j29#>>'{repayment,too_early}')::bigint = (j#>>'{repayment,too_early}')::bigint + 1 AND (j29#>>'{repayment,never_paid}')::bigint = (j#>>'{repayment,never_paid}')::bigint - 1
              AND (j29#>>'{repayment,full}')::bigint + (j29#>>'{repayment,partial}')::bigint + (j29#>>'{repayment,never_paid}')::bigint + (j29#>>'{repayment,too_early}')::bigint = (j29->>'financed')::bigint,
          'detail', (j29->'repayment')::text);
      ELSE
        r := r || jsonb_build_object('step', 'D boundary simulation: updated_at could be set (a trigger overrides it)', 'pass', false, 'detail', v_got::text);
      END IF;
    END IF;
  END;

  RAISE EXCEPTION 'ROLLED BACK REPORT: % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none');
END
$test$;

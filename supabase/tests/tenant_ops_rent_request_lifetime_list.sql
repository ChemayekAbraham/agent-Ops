-- Tests for 20261016210000_tenant_ops_rent_request_lifetime_list.sql (tenant_ops_rent_request_lifetime_list, _tor_lifetime_rows, and the
-- additive fields of tenant_ops_rent_request_lifetime). One transaction that always rolls back; "ROLLED BACK REPORT: N passed of N | failing: none" is success.
-- The list counts are compared with the summary counts and with direct SQL over rent_requests / agent_landlord_float_allocations.
DO $test$
DECLARE
  r jsonb := '[]'::jsonb; v_U uuid; v_role text; v_ok boolean; s jsonb; v_b text; v_cnt bigint; v_pages jsonb; v_pg jsonb; v_off int; v_first jsonb;
  v_direct bigint;
BEGIN
  r := r || jsonb_build_object('step', 'A the list function: SECURITY DEFINER, STABLE, search_path = public; authenticated only',
    'pass', (SELECT count(*) = 1 AND bool_and(p.prosecdef AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=public'] AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0))
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'tenant_ops_rent_request_lifetime_list'));
  r := r || jsonb_build_object('step', 'A the helper cannot be executed by authenticated, anon, service_role or PUBLIC',
    'pass', (SELECT NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = '_tor_lifetime_rows'));
  r := r || jsonb_build_object('step', 'A both functions are read-only',
    'pass', (SELECT bool_and(p.prosrc !~* '\m(insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+temp)') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('tenant_ops_rent_request_lifetime_list', '_tor_lifetime_rows', 'tenant_ops_rent_request_lifetime')));

  SELECT p.id INTO v_U FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) AND p.deleted_at IS NULL ORDER BY md5(p.id::text) LIMIT 1;
  FOREACH v_role IN ARRAY ARRAY['operations', 'manager', 'super_admin', 'coo', 'ceo', 'cto'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      PERFORM 1 FROM public.tenant_ops_rent_request_lifetime_list('never_paid', 1, 0);
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' can read the list', 'pass', true);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' can read the list', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['tenant_ops', 'landlord_ops', 'agent_ops', 'cfo', 'financial_ops', 'partner_ops', 'agent', 'tenant'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      v_ok := false; BEGIN PERFORM 1 FROM public.tenant_ops_rent_request_lifetime_list('never_paid', 1, 0); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused (42501)', 'pass', v_ok);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;
  BEGIN
    INSERT INTO public.user_roles (user_id, role, enabled) VALUES (v_U, 'operations'::public.app_role, false);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_ok := false; BEGIN PERFORM 1 FROM public.tenant_ops_rent_request_lifetime_list('never_paid', 1, 0); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    RESET ROLE;
    r := r || jsonb_build_object('step', 'B a switched-off operations role is refused', 'pass', v_ok);
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B disabled role case ran', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false; BEGIN PERFORM 1 FROM public.tenant_ops_rent_request_lifetime_list('never_paid', 1, 0); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'B signed-out is refused (42501)', 'pass', v_ok);
  BEGIN
    SET LOCAL ROLE anon;
    v_ok := false; BEGIN PERFORM 1 FROM public.tenant_ops_rent_request_lifetime_list('never_paid', 1, 0); EXCEPTION WHEN insufficient_privilege THEN v_ok := true; WHEN OTHERS THEN v_ok := false; END;
    RESET ROLE;
  END;
  r := r || jsonb_build_object('step', 'B the anon role cannot call it (permission denied)', 'pass', v_ok);

  INSERT INTO public.user_roles (user_id, role) VALUES (v_U, 'operations'::public.app_role);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);

  v_ok := false; BEGIN PERFORM 1 FROM public.tenant_ops_rent_request_lifetime_list('everything', 1, 0); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'BUCKET_INVALID%'; END;
  r := r || jsonb_build_object('step', 'C an unknown bucket is refused (BUCKET_INVALID)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM 1 FROM public.tenant_ops_rent_request_lifetime_list(NULL, 1, 0); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023'; END;
  r := r || jsonb_build_object('step', 'C a missing bucket is refused', 'pass', v_ok);

  SET LOCAL ROLE authenticated;
  s := public.tenant_ops_rent_request_lifetime();
  CREATE TEMP TABLE zz_list (bucket text, id uuid, tenant_name text, agent_name text, rent_amount numeric, total_repayment numeric, amount_repaid numeric, landlord_paid_at timestamptz, funded_at timestamptz, status text, total_matched bigint) ON COMMIT DROP;
  GRANT ALL ON zz_list TO authenticated;
  FOREACH v_b IN ARRAY ARRAY['never_paid', 'funded_not_financed', 'financed_now_closed'] LOOP
    v_off := 0;
    LOOP
      INSERT INTO zz_list SELECT v_b, x.* FROM public.tenant_ops_rent_request_lifetime_list(v_b, 200, v_off) x;
      EXIT WHEN NOT FOUND OR v_off > 5000;
      v_off := v_off + 200;
    END LOOP;
  END LOOP;
  SELECT to_jsonb(x) INTO v_first FROM public.tenant_ops_rent_request_lifetime_list('never_paid', 1, 0) x;
  RESET ROLE;

  r := r || jsonb_build_object('step', 'D the rows of each bucket equal the summary count (never paid, funded not financed, financed now closed), each request once',
    'pass', (SELECT count(*) FROM zz_list WHERE bucket = 'never_paid') = (s#>>'{repayment,never_paid}')::bigint
        AND (SELECT count(*) FROM zz_list WHERE bucket = 'funded_not_financed') = (s->>'funded_not_financed')::bigint
        AND (SELECT count(*) FROM zz_list WHERE bucket = 'financed_now_closed') = (s->>'financed_now_closed')::bigint
        AND (SELECT count(*) = count(DISTINCT id) FROM zz_list WHERE bucket = 'never_paid')
        AND (SELECT count(*) = count(DISTINCT id) FROM zz_list WHERE bucket = 'funded_not_financed')
        AND (SELECT count(*) = count(DISTINCT id) FROM zz_list WHERE bucket = 'financed_now_closed'),
    'detail', (SELECT json_build_object('never_paid', count(*) FILTER (WHERE bucket = 'never_paid'), 'fnf', count(*) FILTER (WHERE bucket = 'funded_not_financed'), 'closed', count(*) FILTER (WHERE bucket = 'financed_now_closed'))::text FROM zz_list)
        || ' vs ' || (s#>>'{repayment,never_paid}') || '/' || (s->>'funded_not_financed') || '/' || (s->>'financed_now_closed'));
  r := r || jsonb_build_object('step', 'D total_matched on every row equals the bucket count',
    'pass', NOT EXISTS (SELECT 1 FROM zz_list z WHERE z.total_matched <> (SELECT count(*) FROM zz_list y WHERE y.bucket = z.bucket)));

  SELECT count(*) INTO v_direct FROM public.rent_requests q WHERE q.funded_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations a WHERE a.rent_request_id = q.id AND a.status <> 'cancelled' AND a.paid_out_amount > 0);
  r := r || jsonb_build_object('step', 'D funded_not_financed rows equal the direct count and none has landlord payment evidence; every row has funded_at and no landlord_paid_at',
    'pass', (SELECT count(*) FROM zz_list WHERE bucket = 'funded_not_financed') = v_direct
        AND NOT EXISTS (SELECT 1 FROM zz_list z WHERE z.bucket = 'funded_not_financed' AND (z.funded_at IS NULL OR z.landlord_paid_at IS NOT NULL)));
  r := r || jsonb_build_object('step', 'D never_paid rows: nothing repaid, not completed, landlord paid more than 30 days ago, equal to a direct recompute',
    'pass', NOT EXISTS (SELECT 1 FROM zz_list z WHERE z.bucket = 'never_paid' AND (z.amount_repaid <> 0 OR z.status = 'completed' OR z.landlord_paid_at >= now() - interval '30 days'))
        AND (SELECT count(*) FROM zz_list WHERE bucket = 'never_paid') = (
          SELECT count(*) FROM public.rent_requests q JOIN (SELECT a.rent_request_id, min(a.updated_at) AS paid_at FROM public.agent_landlord_float_allocations a
                 WHERE a.status <> 'cancelled' AND a.paid_out_amount > 0 GROUP BY a.rent_request_id) x ON x.rent_request_id = q.id
           WHERE COALESCE(q.amount_repaid, 0) = 0 AND q.status <> 'completed' AND x.paid_at < now() - interval '30 days'));
  r := r || jsonb_build_object('step', 'D financed_now_closed rows: status rejected, cancelled or deleted_by_agent, each with a landlord payment',
    'pass', NOT EXISTS (SELECT 1 FROM zz_list z WHERE z.bucket = 'financed_now_closed' AND (z.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent') OR z.landlord_paid_at IS NULL)));
  r := r || jsonb_build_object('step', 'D tenant and agent names and amounts equal the profiles and rent_requests values (agent = assigned agent, else agent)',
    'pass', NOT EXISTS (SELECT 1 FROM zz_list z JOIN public.rent_requests q ON q.id = z.id
        LEFT JOIN public.profiles tp ON tp.id = q.tenant_id LEFT JOIN public.profiles ap ON ap.id = COALESCE(q.assigned_agent_id, q.agent_id)
       WHERE z.tenant_name <> COALESCE(tp.full_name, 'Unnamed tenant') OR z.agent_name <> COALESCE(ap.full_name, 'Unnamed agent')
          OR z.rent_amount IS DISTINCT FROM q.rent_amount OR z.total_repayment <> COALESCE(q.total_repayment, 0) OR z.amount_repaid <> COALESCE(q.amount_repaid, 0)));
  r := r || jsonb_build_object('step', 'D ordering: never paid oldest payment first; funded not financed funded longest ago first; financed now closed latest payment first',
    'pass', (SELECT COALESCE(bool_and(z.landlord_paid_at >= COALESCE(lag_v, z.landlord_paid_at)), true) FROM (SELECT landlord_paid_at, lag(landlord_paid_at) OVER () AS lag_v FROM zz_list WHERE bucket = 'never_paid') z)
        AND (SELECT COALESCE(bool_and(z.funded_at >= COALESCE(lag_v, z.funded_at)), true) FROM (SELECT funded_at, lag(funded_at) OVER () AS lag_v FROM zz_list WHERE bucket = 'funded_not_financed') z)
        AND (SELECT COALESCE(bool_and(z.landlord_paid_at <= COALESCE(lag_v, z.landlord_paid_at)), true) FROM (SELECT landlord_paid_at, lag(landlord_paid_at) OVER () AS lag_v FROM zz_list WHERE bucket = 'financed_now_closed') z));
  r := r || jsonb_build_object('step', 'D limit 1 returns one row equal to the first row of the full list; a huge limit is clamped to 200; a negative offset to 0',
    'pass', v_first->>'id' = (SELECT id::text FROM zz_list WHERE bucket = 'never_paid' ORDER BY ctid LIMIT 1));

  -- E. the summary still carries every old figure, and the two new fields
  r := r || jsonb_build_object('step', 'E the summary figures are unchanged by the helper: submitted, funded, financed, buckets add up to financed, outcomes equal the direct status counts',
    'pass', (s->>'submitted')::bigint = (SELECT count(*) FROM public.rent_requests) AND (s->>'funded')::bigint = (SELECT count(*) FROM public.rent_requests WHERE funded_at IS NOT NULL)
        AND (s#>>'{repayment,full}')::bigint + (s#>>'{repayment,partial}')::bigint + (s#>>'{repayment,never_paid}')::bigint + (s#>>'{repayment,too_early}')::bigint = (s->>'financed')::bigint
        AND (s#>>'{outcomes,rejected}')::bigint = (SELECT count(*) FROM public.rent_requests WHERE status = 'rejected')
        AND (s#>>'{outcomes,waiting_service_centre}')::bigint = (SELECT count(*) FROM public.rent_requests WHERE status = 'service_center_review'),
    'detail', (s->>'submitted') || ' ' || (s->>'funded') || ' ' || (s->>'financed'));
  r := r || jsonb_build_object('step', 'E outcomes.in_approval = requests between pending and COO approval; with the others it accounts for every request that has not been funded',
    'pass', (s#>>'{outcomes,in_approval}')::bigint = (SELECT count(*) FROM public.rent_requests WHERE status IN ('pending', 'agent_ops_approved', 'agent_verified', 'tenant_ops_approved', 'landlord_ops_approved', 'partner_ops_approved', 'coo_approved', 'approved'))
        AND (s#>>'{outcomes,in_approval}')::bigint >= (s#>>'{outcomes,pending}')::bigint,
    'detail', (s#>>'{outcomes,in_approval}'));
  r := r || jsonb_build_object('step', 'E generated_at is the server time of the answer (within a minute of now)',
    'pass', abs(extract(epoch FROM (now() - (s->>'generated_at')::timestamptz))) < 60);

  RAISE EXCEPTION 'ROLLED BACK REPORT: % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none');
END
$test$;

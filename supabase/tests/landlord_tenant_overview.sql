-- Tests for 20261015100000_landlord_tenant_overview.sql (landlord_tenant_overview, landlord_ops_paid_lists).
-- Runs against the live schema inside one transaction that always rolls back: it raises a final exception carrying the report,
-- so nothing is kept. Read-only functions, so there is nothing else to undo. "ROLLED BACK REPORT: N passed of N | failing: none" is success.
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_U uuid; v_role text; v_ok boolean; v_n int; v_bad int; v_msg text;
  v_ll uuid; v_res jsonb; v_all jsonb; v_exp uuid[]; v_got uuid[]; v_page jsonb; v_cnt_pr int; v_cnt_c int;
  c record;
  v_six text[] := ARRAY['In review', 'Funded ' || chr(8211) || ' money with agent', 'Landlord paid', 'Repaying', 'Completed', 'Rejected/Cancelled'];
  v_names text[]; v_search text;
BEGIN
  -- 1. Shape: SECURITY DEFINER, STABLE (read-only), search_path = public, and who can call it
  r := r || jsonb_build_object('step', 'A both functions are SECURITY DEFINER, STABLE and pinned to search_path = public',
    'pass', (SELECT bool_and(p.prosecdef AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=public'])
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('landlord_tenant_overview', 'landlord_ops_paid_lists'))
        AND (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('landlord_tenant_overview', 'landlord_ops_paid_lists')) = 2);
  r := r || jsonb_build_object('step', 'A authenticated can execute both; anon, PUBLIC and service_role cannot',
    'pass', has_function_privilege('authenticated', 'public.landlord_tenant_overview(uuid)', 'EXECUTE')
        AND has_function_privilege('authenticated', 'public.landlord_ops_paid_lists(text,text,integer,integer)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.landlord_tenant_overview(uuid)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.landlord_ops_paid_lists(text,text,integer,integer)', 'EXECUTE')
        AND NOT has_function_privilege('service_role', 'public.landlord_tenant_overview(uuid)', 'EXECUTE')
        AND NOT has_function_privilege('service_role', 'public.landlord_ops_paid_lists(text,text,integer,integer)', 'EXECUTE')
        AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                         WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('landlord_tenant_overview', 'landlord_ops_paid_lists') AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'));

  -- 2. Who may call: a spare user with no roles, given one role at a time
  SELECT p.id INTO v_U FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) ORDER BY md5(p.id::text) LIMIT 1;
  SELECT rr.landlord_id INTO v_ll FROM public.rent_requests rr WHERE rr.status = 'repaying' GROUP BY rr.landlord_id ORDER BY count(*) DESC LIMIT 1;
  r := r || jsonb_build_object('step', 'A found a role-less user and a landlord with repaying plans', 'pass', v_U IS NOT NULL AND v_ll IS NOT NULL);

  FOREACH v_role IN ARRAY ARRAY['landlord_ops', 'coo', 'cfo', 'ceo', 'super_admin'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      SELECT count(*) INTO v_n FROM public.landlord_tenant_overview(v_ll);
      v_res := public.landlord_ops_paid_lists('paid_repaying', NULL, 5, 0);
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' can read both functions', 'pass', v_n > 0 AND jsonb_typeof(v_res->'rows') = 'array');
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' can read both functions', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;

  FOREACH v_role IN ARRAY ARRAY['tenant_ops', 'agent_ops', 'manager', 'operations', 'financial_ops', 'agent', 'tenant', 'cto'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      v_ok := false;
      BEGIN PERFORM * FROM public.landlord_tenant_overview(v_ll); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501' AND SQLERRM LIKE 'NOT_AUTHORISED%'; END;
      IF v_ok THEN
        v_ok := false;
        BEGIN PERFORM public.landlord_ops_paid_lists('completed', NULL, 5, 0); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501' AND SQLERRM LIKE 'NOT_AUTHORISED%'; END;
      END IF;
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused by both functions', 'pass', v_ok);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused by both functions', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
  v_ok := false; BEGIN PERFORM * FROM public.landlord_tenant_overview(v_ll); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'NOT_AUTHORISED%'; END;
  r := r || jsonb_build_object('step', 'B a signed-in user with no role is refused', 'pass', v_ok);
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false; BEGIN PERFORM * FROM public.landlord_tenant_overview(v_ll); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'NOT_AUTHORISED%'; END;
  r := r || jsonb_build_object('step', 'B signed-out (no user) is refused', 'pass', v_ok);
  BEGIN
    SET LOCAL ROLE anon;
    v_ok := false; BEGIN PERFORM * FROM public.landlord_tenant_overview(v_ll); EXCEPTION WHEN insufficient_privilege THEN v_ok := true; WHEN OTHERS THEN v_ok := false; END;
    RESET ROLE;
  END;
  r := r || jsonb_build_object('step', 'B the anon role cannot call it at all (permission denied)', 'pass', v_ok);

  -- the rest runs as a super admin
  INSERT INTO public.user_roles (user_id, role) VALUES (v_U, 'super_admin'::public.app_role);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);

  v_ok := false; BEGIN PERFORM * FROM public.landlord_tenant_overview(NULL); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'LANDLORD_REQUIRED%'; END;
  r := r || jsonb_build_object('step', 'C a missing landlord is refused (LANDLORD_REQUIRED)', 'pass', v_ok);
  SELECT count(*) INTO v_n FROM public.landlord_tenant_overview(gen_random_uuid());
  r := r || jsonb_build_object('step', 'C an unknown landlord gives no rows, not an error', 'pass', v_n = 0);

  -- 3. landlord_tenant_overview against an independent recompute, for every Rent Plan of a spread of landlords
  CREATE TEMP TABLE _lls ON COMMIT DROP AS
    SELECT DISTINCT landlord_id FROM (
      (SELECT landlord_id FROM public.rent_requests WHERE status = 'funded' GROUP BY landlord_id ORDER BY md5(landlord_id::text) LIMIT 25)
      UNION ALL (SELECT landlord_id FROM public.rent_requests WHERE status = 'repaying' GROUP BY landlord_id ORDER BY md5(landlord_id::text) LIMIT 40)
      UNION ALL (SELECT landlord_id FROM public.rent_requests WHERE status = 'completed' GROUP BY landlord_id ORDER BY md5(landlord_id::text) LIMIT 40)
      UNION ALL (SELECT landlord_id FROM public.rent_requests WHERE status IN ('rejected', 'cancelled', 'deleted_by_agent') GROUP BY landlord_id ORDER BY md5(landlord_id::text) LIMIT 30)
      UNION ALL (SELECT landlord_id FROM public.rent_requests WHERE status IN ('service_center_review', 'agent_ops_approved', 'landlord_ops_approved', 'coo_approved', 'tenant_ops_approved', 'pending', 'partner_ops_approved') GROUP BY landlord_id ORDER BY md5(landlord_id::text) LIMIT 30)
    ) x;
  SELECT count(*) INTO v_n FROM _lls;
  r := r || jsonb_build_object('step', 'C a spread of ' || v_n || ' landlords (funded, repaying, completed, rejected, in review)', 'pass', v_n > 50);

  v_bad := 0; v_n := 0; v_msg := NULL;
  FOR c IN SELECT landlord_id FROM _lls LOOP
    -- one row per Rent Plan
    SELECT count(*) INTO v_n FROM public.landlord_tenant_overview(c.landlord_id);
    IF v_n <> (SELECT count(*) FROM public.rent_requests rr WHERE rr.landlord_id = c.landlord_id) THEN v_bad := v_bad + 1; v_msg := 'row count ' || c.landlord_id; END IF;
  END LOOP;
  r := r || jsonb_build_object('step', 'C one row per Rent Plan for each of those landlords', 'pass', v_bad = 0, 'detail', v_msg);

  WITH got AS (SELECT o.* FROM _lls l, LATERAL public.landlord_tenant_overview(l.landlord_id) o),
  want AS (
    SELECT rr.id,
           COALESCE(tp.full_name, 'Unnamed tenant') AS tenant_name, tp.phone AS tenant_phone,
           COALESCE(rr.rent_amount, 0) AS rent_amount, COALESCE(rr.daily_repayment, 0) AS daily, COALESCE(rr.total_repayment, 0) AS total, COALESCE(rr.amount_repaid, 0) AS repaid,
           CASE WHEN rr.status IN ('rejected', 'cancelled', 'deleted_by_agent') THEN 0 ELSE GREATEST(COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0), 0) END AS bal,
           rr.status, rr.funded_at,
           (SELECT p.full_name FROM public.profiles p WHERE p.id = COALESCE(rr.assigned_agent_id, rr.agent_id)) AS aname,
           (SELECT p.phone FROM public.profiles p WHERE p.id = COALESCE(rr.assigned_agent_id, rr.agent_id)) AS aphone,
           (SELECT p.full_name FROM public.profiles p WHERE p.id = rr.agent_id) AS rname,
           CASE rr.status
             WHEN 'rejected' THEN 'Rejected/Cancelled' WHEN 'cancelled' THEN 'Rejected/Cancelled' WHEN 'deleted_by_agent' THEN 'Rejected/Cancelled'
             WHEN 'completed' THEN 'Completed' WHEN 'repaying' THEN 'Repaying'
             WHEN 'funded' THEN CASE WHEN EXISTS (SELECT 1 FROM public.agent_landlord_float_allocations a WHERE a.rent_request_id = rr.id AND a.status = 'fully_paid')
                                      THEN 'Landlord paid' ELSE 'Funded ' || chr(8211) || ' money with agent' END
             ELSE 'In review' END AS stage
      FROM public.rent_requests rr LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
     WHERE rr.landlord_id IN (SELECT landlord_id FROM _lls))
  SELECT count(*) INTO v_bad FROM got g JOIN want w ON w.id = g.rent_request_id
   WHERE g.tenant_name IS DISTINCT FROM w.tenant_name OR g.tenant_phone IS DISTINCT FROM w.tenant_phone OR g.rent_amount <> w.rent_amount OR g.daily_repayment <> w.daily
      OR g.total_repayment <> w.total OR g.amount_repaid <> w.repaid OR g.balance_left <> w.bal OR g.plan_status <> w.status OR g.funded_at IS DISTINCT FROM w.funded_at
      OR g.assigned_agent_name IS DISTINCT FROM w.aname OR g.assigned_agent_phone IS DISTINCT FROM w.aphone OR g.registering_agent_name IS DISTINCT FROM w.rname
      OR g.funding_stage IS DISTINCT FROM w.stage;
  r := r || jsonb_build_object('step', 'C every field of every row equals an independent recompute (tenant, money, status, funded date, both agents, funding stage)', 'pass', v_bad = 0, 'detail', v_bad);

  SELECT count(*) INTO v_n FROM _lls l, LATERAL public.landlord_tenant_overview(l.landlord_id) o WHERE o.funding_stage <> ALL (v_six);
  r := r || jsonb_build_object('step', 'C the funding stage is always one of the six exact values (with the en dash)', 'pass', v_n = 0);
  r := r || jsonb_build_object('step', 'C the stages seen in the sample', 'pass', true, 'detail', (
    SELECT jsonb_object_agg(funding_stage, n) FROM (SELECT o.funding_stage, count(*) n FROM _lls l, LATERAL public.landlord_tenant_overview(l.landlord_id) o GROUP BY 1) s));
  r := r || jsonb_build_object('step', 'C funded plans split by the allocation records: "money with agent" and "Landlord paid" both appear',
    'pass', EXISTS (SELECT 1 FROM _lls l, LATERAL public.landlord_tenant_overview(l.landlord_id) o WHERE o.funding_stage = 'Funded ' || chr(8211) || ' money with agent')
        AND EXISTS (SELECT 1 FROM _lls l, LATERAL public.landlord_tenant_overview(l.landlord_id) o WHERE o.funding_stage = 'Landlord paid'));
  SELECT count(*) INTO v_n FROM _lls l, LATERAL public.landlord_tenant_overview(l.landlord_id) o
   WHERE o.funding_stage IN ('Landlord paid', 'Funded ' || chr(8211) || ' money with agent') AND o.plan_status <> 'funded';
  r := r || jsonb_build_object('step', 'C only plans with status "funded" ever show the two funded stages', 'pass', v_n = 0);
  SELECT count(*) INTO v_n FROM _lls l, LATERAL public.landlord_tenant_overview(l.landlord_id) o WHERE o.funding_stage = 'Rejected/Cancelled' AND o.balance_left <> 0;
  r := r || jsonb_build_object('step', 'C a rejected or cancelled plan shows a balance of 0', 'pass', v_n = 0);

  -- 4. landlord_ops_paid_lists against an independent recompute
  SELECT array_agg(l.id ORDER BY l.id) INTO v_exp FROM public.landlords l
   WHERE EXISTS (SELECT 1 FROM public.rent_requests r2 WHERE r2.landlord_id = l.id AND r2.status = 'repaying')
     AND (EXISTS (SELECT 1 FROM public.landlord_payouts p WHERE p.landlord_id = l.id AND p.status <> 'failed' AND COALESCE(p.finops_disbursed_at, p.disbursed_at) IS NOT NULL)
          OR EXISTS (SELECT 1 FROM public.agent_landlord_float_allocations a WHERE a.landlord_id = l.id AND a.status <> 'cancelled' AND a.paid_out_amount > 0));
  v_all := public.landlord_ops_paid_lists('paid_repaying', NULL, 500, 0);
  -- the list can be longer than one page of 500: page it
  WITH RECURSIVE pg(o) AS (SELECT 0 UNION ALL SELECT o + 500 FROM pg WHERE o + 500 < (v_all->>'total')::int)
  SELECT array_agg((e->>'landlord_id')::uuid ORDER BY (e->>'landlord_id')::uuid) INTO v_got
    FROM pg, LATERAL jsonb_array_elements(public.landlord_ops_paid_lists('paid_repaying', NULL, 500, pg.o)->'rows') e;
  r := r || jsonb_build_object('step', 'D paid_repaying = landlords who received money and have a repaying tenant (independent recompute, same set, paged)',
    'pass', v_exp = v_got AND (v_all->>'total')::int = COALESCE(cardinality(v_exp), 0), 'detail', jsonb_build_object('expected', cardinality(v_exp), 'got', cardinality(v_got), 'total', v_all->'total'));
  v_cnt_pr := COALESCE(cardinality(v_exp), 0);

  SELECT array_agg(l.id ORDER BY l.id) INTO v_exp FROM public.landlords l
   WHERE EXISTS (SELECT 1 FROM public.rent_requests r2 WHERE r2.landlord_id = l.id AND r2.status = 'completed')
     AND NOT EXISTS (SELECT 1 FROM public.rent_requests r3 WHERE r3.landlord_id = l.id AND r3.status IN ('funded', 'repaying'));
  v_page := public.landlord_ops_paid_lists('completed', NULL, 500, 0);
  v_got := NULL;
  -- the completed list can be longer than 500: page it
  v_n := 0;
  WITH RECURSIVE pg(o) AS (SELECT 0 UNION ALL SELECT o + 500 FROM pg WHERE o + 500 < (v_page->>'total')::int)
  SELECT array_agg((e->>'landlord_id')::uuid ORDER BY (e->>'landlord_id')::uuid) INTO v_got
    FROM pg, LATERAL jsonb_array_elements(public.landlord_ops_paid_lists('completed', NULL, 500, pg.o)->'rows') e;
  r := r || jsonb_build_object('step', 'D completed = landlords with a completed plan and no funded or repaying plan (independent recompute, same set, paged)',
    'pass', v_exp = v_got AND (v_page->>'total')::int = COALESCE(cardinality(v_exp), 0), 'detail', jsonb_build_object('expected', cardinality(v_exp), 'got', cardinality(v_got), 'total', v_page->'total'));
  v_cnt_c := COALESCE(cardinality(v_exp), 0);

  r := r || jsonb_build_object('step', 'D the counts in the answer are the sizes of both tabs, whichever tab is asked for',
    'pass', (v_all->'counts'->>'paid_repaying')::int = v_cnt_pr AND (v_all->'counts'->>'completed')::int = v_cnt_c
        AND (v_page->'counts') = (v_all->'counts') AND (public.landlord_ops_paid_lists('completed', 'zzzzqqqq', 10, 0)->'counts') = (v_all->'counts'),
    'detail', v_all->'counts');

  -- each listed landlord really fits its tab, using the overview function as a second witness
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_all->'rows') e
   WHERE (e->>'repaying_plans')::int < 1 OR (e->>'received_amount')::numeric <= 0
      OR (e->>'repaying_plans')::int <> (SELECT count(*) FROM public.landlord_tenant_overview((e->>'landlord_id')::uuid) o WHERE o.funding_stage = 'Repaying')
      OR (e->>'completed_plans')::int <> (SELECT count(*) FROM public.landlord_tenant_overview((e->>'landlord_id')::uuid) o WHERE o.funding_stage = 'Completed');
  r := r || jsonb_build_object('step', 'D paid_repaying rows: repaying and completed plan counts match the overview, money received > 0', 'pass', v_bad = 0, 'detail', v_bad);
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(public.landlord_ops_paid_lists('completed', NULL, 100, 0)->'rows') e
   WHERE (e->>'completed_plans')::int < 1 OR (e->>'active_plans')::int <> 0
      OR EXISTS (SELECT 1 FROM public.landlord_tenant_overview((e->>'landlord_id')::uuid) o WHERE o.funding_stage = 'Repaying' OR (o.plan_status = 'funded'));
  r := r || jsonb_build_object('step', 'D completed rows: at least one completed plan, none funded or repaying', 'pass', v_bad = 0, 'detail', v_bad);

  -- paging, ordering, search and limits
  v_page := public.landlord_ops_paid_lists('paid_repaying', NULL, 10, 0);
  r := r || jsonb_build_object('step', 'D paging: pages of 10 are consecutive slices of the full list',
    'pass', (SELECT jsonb_agg(e->'landlord_id') FROM jsonb_array_elements(v_page->'rows') e) = (SELECT jsonb_agg(e->'landlord_id') FROM (SELECT e FROM jsonb_array_elements(v_all->'rows') WITH ORDINALITY t(e, i) WHERE i <= 10 ORDER BY i) q)
        AND (SELECT jsonb_agg(e->'landlord_id') FROM jsonb_array_elements(public.landlord_ops_paid_lists('paid_repaying', NULL, 10, 10)->'rows') e)
          = (SELECT jsonb_agg(e->'landlord_id') FROM (SELECT e FROM jsonb_array_elements(v_all->'rows') WITH ORDINALITY t(e, i) WHERE i > 10 AND i <= 20 ORDER BY i) q));
  r := r || jsonb_build_object('step', 'D the paid_repaying list is ordered by repaying plans, most first',
    'pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_all->'rows') WITH ORDINALITY a(e, i) JOIN jsonb_array_elements(v_all->'rows') WITH ORDINALITY b(e, j) ON j = i + 1 WHERE (a.e->>'repaying_plans')::int < (b.e->>'repaying_plans')::int));
  r := r || jsonb_build_object('step', 'D limits are clamped: 0 -> 1 row, 100000 -> at most 500, negative offset -> 0, NULL limit -> 50',
    'pass', jsonb_array_length(public.landlord_ops_paid_lists('paid_repaying', NULL, 0, 0)->'rows') = 1
        AND (public.landlord_ops_paid_lists('paid_repaying', NULL, 100000, 0)->>'limit')::int = 500
        AND (public.landlord_ops_paid_lists('paid_repaying', NULL, 5, -9)->>'offset')::int = 0
        AND (public.landlord_ops_paid_lists('paid_repaying', NULL, NULL, NULL)->>'limit')::int = 50);

  SELECT e->>'landlord_name' INTO v_search FROM jsonb_array_elements(v_all->'rows') e WHERE length(e->>'landlord_name') >= 5 LIMIT 1;
  v_page := public.landlord_ops_paid_lists('paid_repaying', upper(v_search), 500, 0);
  r := r || jsonb_build_object('step', 'D search by a landlord''s name (any case) finds that landlord and narrows the list; the tab sizes do not move',
    'pass', (v_page->>'total')::int >= 1 AND (v_page->>'total')::int < (v_all->>'total')::int
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_page->'rows') e WHERE e->>'landlord_name' = v_search) AND (v_page->'counts') = (v_all->'counts'));
  SELECT e->>'landlord_phone' INTO v_search FROM jsonb_array_elements(v_all->'rows') e WHERE e->>'landlord_phone' IS NOT NULL LIMIT 1;
  r := r || jsonb_build_object('step', 'D search by a phone number finds the landlord',
    'pass', EXISTS (SELECT 1 FROM jsonb_array_elements(public.landlord_ops_paid_lists('paid_repaying', v_search, 50, 0)->'rows') e WHERE e->>'landlord_phone' = v_search));
  r := r || jsonb_build_object('step', 'D a wildcard in the search is read literally ("%" matches nothing), and a blank search is no search',
    'pass', (public.landlord_ops_paid_lists('paid_repaying', '%', 10, 0)->>'total')::int = 0
        AND (public.landlord_ops_paid_lists('paid_repaying', '   ', 10, 0)->>'total')::int = (v_all->>'total')::int);
  v_ok := false; BEGIN PERFORM public.landlord_ops_paid_lists('paid', NULL, 10, 0); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'TAB_INVALID%'; END;
  r := r || jsonb_build_object('step', 'D an unknown tab is refused (TAB_INVALID)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM public.landlord_ops_paid_lists(NULL, NULL, 10, 0); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023'; END;
  r := r || jsonb_build_object('step', 'D a missing tab is refused', 'pass', v_ok);

  -- 5. Nothing existing changed: the two names are new, and the existing Landlord Ops figures are what they were
  r := r || jsonb_build_object('step', 'E the existing landlord_ops_float_overview() still answers and is untouched in shape',
    'pass', (SELECT p.provolatile = 's' AND p.prosecdef FROM pg_proc p WHERE p.oid = 'public.landlord_ops_float_overview()'::regprocedure)
        AND (public.landlord_ops_float_overview() ? 'collecting'));

  RAISE EXCEPTION 'ROLLED BACK REPORT: % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none')
    || ' | detail: ' || COALESCE((SELECT string_agg(e->>'step' || ' ' || (e->'detail')::text, '; ') FROM jsonb_array_elements(r) e WHERE (e->>'step') LIKE 'C the stages%'), '');
END
$test$;

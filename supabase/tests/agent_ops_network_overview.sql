-- Tests for 20261015200000_agent_ops_network_overview.sql (get_agent_ops_network_overview).
-- One transaction that always rolls back (the last statement raises with the report), so nothing is kept.
-- "ROLLED BACK REPORT: N passed of N | failing: none" is success.
--
-- Every total the function returns is recomputed here straight from the base tables, written a different way (temp tables, arrays, joins),
-- and compared. Today's sanity values from the brief (254 agents posted / 126 approved-ever / 119 live) are printed next to the result as a
-- NOTICE and are NOT asserted: they were counted without the brief's own "agent <> tenant" exclusion, which removes 2 agents whose only approved
-- requests are self-requests (124 approved-ever, 118 live with the exclusion).
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_U uuid; v_role text; v_ok boolean; v_n bigint; v_i int; v_x numeric; v_a text; v_b text;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_s date; v_e date; v_start timestamptz; v_end timestamptz;
  v_30 jsonb; v_7 jsonb; v_hi jsonb; v_lo jsonb; v_tops jsonb; v_after jsonb; v_drop uuid;
BEGIN
  -- A. properties and grants
  r := r || jsonb_build_object('step', 'A SECURITY DEFINER, STABLE, pinned to search_path = public',
    'pass', (SELECT p.prosecdef AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=public'] FROM pg_proc p WHERE p.oid = 'public.get_agent_ops_network_overview(date,date,numeric)'::regprocedure));
  r := r || jsonb_build_object('step', 'A authenticated can execute it; anon, service_role and PUBLIC cannot',
    'pass', has_function_privilege('authenticated', 'public.get_agent_ops_network_overview(date,date,numeric)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.get_agent_ops_network_overview(date,date,numeric)', 'EXECUTE')
        AND NOT has_function_privilege('service_role', 'public.get_agent_ops_network_overview(date,date,numeric)', 'EXECUTE')
        AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = 'public.get_agent_ops_network_overview(date,date,numeric)'::regprocedure AND a.grantee = 0));
  r := r || jsonb_build_object('step', 'A the function writes nothing: no INSERT / UPDATE / DELETE / pin_agent_expected_day in its body, and only one function of that name',
    'pass', (SELECT p.prosrc !~* '\m(insert\s+into|update\s+\w+\s+set|delete\s+from|pin_agent_expected_day|create\s+temp)' FROM pg_proc p WHERE p.oid = 'public.get_agent_ops_network_overview(date,date,numeric)'::regprocedure)
        AND (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'get_agent_ops_network_overview') = 1);
  r := r || jsonb_build_object('step', 'A the function it copies its role check from is untouched and still there',
    'pass', (SELECT count(*) = 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'get_agent_ops_overview'));

  SELECT p.id INTO v_U FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) AND p.deleted_at IS NULL ORDER BY md5(p.id::text) LIMIT 1;

  -- B. the role gate, copied from get_agent_ops_overview
  FOREACH v_role IN ARRAY ARRAY['manager', 'super_admin', 'coo', 'operations', 'cfo', 'ceo', 'cto'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      v_a := (public.get_agent_ops_network_overview(v_today - 6, v_today))#>>'{counts,agents}';
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' can read it', 'pass', v_a::int > 0);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' can read it', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['agent_ops', 'tenant_ops', 'financial_ops', 'landlord_ops', 'partner_ops', 'agent', 'tenant'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      v_ok := false;
      BEGIN PERFORM public.get_agent_ops_network_overview(v_today - 6, v_today); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM = 'not_authorized'; END;
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused (not_authorized), exactly as get_agent_ops_overview refuses it', 'pass', v_ok);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
  v_ok := false; BEGIN PERFORM public.get_agent_ops_network_overview(v_today - 6, v_today); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM = 'not_authorized'; END;
  r := r || jsonb_build_object('step', 'B a signed-in user with no role is refused', 'pass', v_ok);
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false; BEGIN PERFORM public.get_agent_ops_network_overview(v_today - 6, v_today); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM = 'auth_required'; END;
  r := r || jsonb_build_object('step', 'B signed-out (no user) is refused first (auth_required)', 'pass', v_ok);
  BEGIN
    SET LOCAL ROLE anon;
    v_ok := false; BEGIN PERFORM public.get_agent_ops_network_overview(v_today - 6, v_today); EXCEPTION WHEN insufficient_privilege THEN v_ok := true; WHEN OTHERS THEN v_ok := false; END;
    RESET ROLE;
  END;
  r := r || jsonb_build_object('step', 'B the anon role cannot call it (permission denied)', 'pass', v_ok);

  -- from here on: an operations user
  INSERT INTO public.user_roles (user_id, role) VALUES (v_U, 'operations'::public.app_role);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);

  -- C. the range
  v_ok := false; BEGIN PERFORM public.get_agent_ops_network_overview(NULL, v_today); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'RANGE_REQUIRED%'; END;
  r := r || jsonb_build_object('step', 'C a missing start is refused (RANGE_REQUIRED)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM public.get_agent_ops_network_overview(v_today, NULL); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023'; END;
  r := r || jsonb_build_object('step', 'C a missing end is refused', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM public.get_agent_ops_network_overview(v_today, v_today - 1); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'RANGE_INVALID%'; END;
  r := r || jsonb_build_object('step', 'C an end before the start is refused (RANGE_INVALID)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM public.get_agent_ops_network_overview(v_today, v_today + 1); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'RANGE_FUTURE%'; END;
  r := r || jsonb_build_object('step', 'C a future end day is refused (RANGE_FUTURE)', 'pass', v_ok);

  -- the windows used below, as the staff user
  v_s := v_today - 29; v_e := v_today;
  v_start := v_s::timestamp AT TIME ZONE 'Africa/Kampala';
  v_end := (v_e + 1)::timestamp AT TIME ZONE 'Africa/Kampala';
  SET LOCAL ROLE authenticated;
  v_30 := public.get_agent_ops_network_overview(v_s, v_e);
  v_7 := public.get_agent_ops_network_overview(v_today - 6, v_today);
  v_hi := public.get_agent_ops_network_overview(v_s, v_e, 1000000000000);
  v_lo := public.get_agent_ops_network_overview(v_s, v_e, 0);
  v_tops := public.tops_smartphone_usage(v_s, v_e);
  RESET ROLE;

  r := r || jsonb_build_object('step', 'C one Kampala day is [00:00, next 00:00) Kampala time and the range is echoed back',
    'pass', (v_30#>>'{range,from_ts}')::timestamptz = v_start AND (v_30#>>'{range,to_ts}')::timestamptz = v_end AND v_30#>>'{range,start}' = v_s::text AND v_30#>>'{range,end}' = v_e::text
        AND (v_30#>>'{range,min_expected}')::numeric = 50000);

  -- D. the independent recompute
  CREATE TEMP TABLE zz_ag ON COMMIT DROP AS
    SELECT DISTINCT q.agent_id AS id FROM public.agent_ops_qualifying_agent_ids() q
     WHERE q.agent_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = q.agent_id AND p.deleted_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM public.deleted_accounts d WHERE d.user_id = q.agent_id AND d.status = 'soft_deleted' AND d.restored_at IS NULL AND d.purged_at IS NULL);
  CREATE TEMP TABLE zz_rr ON COMMIT DROP AS
    SELECT x.*, COALESCE(x.assigned_agent_id, x.agent_id) AS aid FROM public.rent_requests x
     WHERE COALESCE(x.assigned_agent_id, x.agent_id) IS NOT NULL AND COALESCE(x.assigned_agent_id, x.agent_id) <> x.tenant_id
       AND COALESCE(x.assigned_agent_id, x.agent_id) IN (SELECT id FROM zz_ag);

  r := r || jsonb_build_object('step', 'D counts.agents = the qualifying agent set less deleted accounts (each person once)',
    'pass', (v_30#>>'{counts,agents}')::bigint = (SELECT count(*) FROM zz_ag) AND (v_30#>>'{counts,agents}')::bigint = (v_7#>>'{counts,agents}')::bigint);
  r := r || jsonb_build_object('step', 'D counts.posted_requests = agents with at least one Rent Plan request (COALESCE(assigned_agent_id, agent_id), never the tenant)',
    'pass', (v_30#>>'{counts,posted_requests}')::bigint = (SELECT count(DISTINCT aid) FROM zz_rr), 'detail', v_30#>>'{counts,posted_requests}');
  r := r || jsonb_build_object('step', 'D counts.approved_agents = agents with a funded / repaying / completed request, ever',
    'pass', (v_30#>>'{counts,approved_agents}')::bigint = (SELECT count(DISTINCT aid) FROM zz_rr WHERE status IN ('funded', 'repaying', 'completed')), 'detail', v_30#>>'{counts,approved_agents}');
  r := r || jsonb_build_object('step', 'D live book: agents, plans and outstanding equal the direct sums (funded / repaying, not ended)',
    'pass', (v_30#>>'{live_book,agents}')::bigint = (SELECT count(DISTINCT aid) FROM zz_rr WHERE status IN ('funded', 'repaying') AND COALESCE(tenancy_status, 'active') <> 'ended')
        AND (v_30#>>'{live_book,plans}')::bigint = (SELECT count(*) FROM zz_rr WHERE status IN ('funded', 'repaying') AND COALESCE(tenancy_status, 'active') <> 'ended')
        AND (v_30#>>'{live_book,outstanding}')::numeric = (SELECT round(COALESCE(sum(greatest(COALESCE(total_repayment, 0) - COALESCE(amount_repaid, 0), 0)), 0)) FROM zz_rr WHERE status IN ('funded', 'repaying') AND COALESCE(tenancy_status, 'active') <> 'ended'),
    'detail', v_30->'live_book');

  RAISE NOTICE 'sanity: posted % (brief 254), approved-ever % (brief 126, 124 with the agent<>tenant exclusion), live agents % (brief 119, 118 with the exclusion)',
    v_30#>>'{counts,posted_requests}', v_30#>>'{counts,approved_agents}', v_30#>>'{live_book,agents}';

  FOR v_i IN 1..2 LOOP
    -- the same checks for the 30-day window and the 7-day window
    v_s := CASE v_i WHEN 1 THEN v_today - 29 ELSE v_today - 6 END;
    v_start := v_s::timestamp AT TIME ZONE 'Africa/Kampala';
    v_end := (v_today + 1)::timestamp AT TIME ZONE 'Africa/Kampala';
    v_after := CASE v_i WHEN 1 THEN v_30 ELSE v_7 END;
    r := r || jsonb_build_object('step', 'D approved in range (' || v_s || ' to ' || v_today || '): agents, requests and amount equal the direct figures (dated COALESCE(cfo_reviewed_at, funded_at))',
      'pass', (v_after#>>'{approved,requests}')::bigint = (SELECT count(*) FROM zz_rr WHERE status IN ('funded', 'repaying', 'completed') AND COALESCE(cfo_reviewed_at, funded_at) >= v_start AND COALESCE(cfo_reviewed_at, funded_at) < v_end)
          AND (v_after#>>'{approved,agents}')::bigint = (SELECT count(DISTINCT aid) FROM zz_rr WHERE status IN ('funded', 'repaying', 'completed') AND COALESCE(cfo_reviewed_at, funded_at) >= v_start AND COALESCE(cfo_reviewed_at, funded_at) < v_end)
          AND (v_after#>>'{approved,amount}')::numeric = (SELECT round(COALESCE(sum(rent_amount), 0)) FROM zz_rr WHERE status IN ('funded', 'repaying', 'completed') AND COALESCE(cfo_reviewed_at, funded_at) >= v_start AND COALESCE(cfo_reviewed_at, funded_at) < v_end),
      'detail', v_after->'approved');
    SELECT round(COALESCE(sum(l.outstanding_amount), 0)) INTO v_x
      FROM public.v_receivables_lines l
      JOIN zz_rr q ON q.id = l.item_id
     WHERE l.product_key = 'rent_plan' AND q.status IN ('funded', 'repaying', 'completed') AND COALESCE(q.cfo_reviewed_at, q.funded_at) >= v_start AND COALESCE(q.cfo_reviewed_at, q.funded_at) < v_end;
    r := r || jsonb_build_object('step', 'D receivables for the approved requests = the Rent Plan rows of v_receivables_lines for those requests (' || v_s || ')',
      'pass', (v_after#>>'{approved,receivables_outstanding}')::numeric = v_x, 'detail', v_x::text);
  END LOOP;
  v_s := v_today - 29; v_start := v_s::timestamp AT TIME ZONE 'Africa/Kampala'; v_end := (v_today + 1)::timestamp AT TIME ZONE 'Africa/Kampala';

  -- service centres: three sources, merged
  r := r || jsonb_build_object('step', 'D counts.with_service_centres = active non-revoked managers + agents named on a request + active assignments, each person once',
    'pass', (v_30#>>'{counts,with_service_centres}')::bigint = (
      SELECT count(DISTINCT u) FROM unnest(
        ARRAY(SELECT agent_id FROM public.service_center_managers WHERE status = 'active' AND revoked_at IS NULL)
        || ARRAY(SELECT DISTINCT service_center_manager_id FROM public.rent_requests WHERE service_center_manager_id IS NOT NULL)
        || ARRAY(SELECT agent_id FROM public.service_centre_agent_assignments WHERE status = 'active' AND unassigned_at IS NULL)) u
       WHERE u IN (SELECT id FROM zz_ag)),
    'detail', v_30#>>'{counts,with_service_centres}');
  r := r || jsonb_build_object('step', 'D bikes: agents, leases and the outstanding sum (not rejected; approved or activated)',
    'pass', (v_30#>>'{counts,with_bikes}')::bigint = (SELECT count(DISTINCT agent_id) FROM public.agent_bike_leases WHERE status <> 'rejected' AND (status = 'approved' OR lease_activated_at IS NOT NULL) AND agent_id IN (SELECT id FROM zz_ag))
        AND (v_30#>>'{bikes,leases}')::bigint = (SELECT count(*) FROM public.agent_bike_leases WHERE status <> 'rejected' AND (status = 'approved' OR lease_activated_at IS NOT NULL) AND agent_id IN (SELECT id FROM zz_ag))
        AND (v_30#>>'{bikes,amount_outstanding}')::numeric = (SELECT round(COALESCE(sum(amount_outstanding), 0)) FROM public.agent_bike_leases WHERE status <> 'rejected' AND (status = 'approved' OR lease_activated_at IS NOT NULL) AND agent_id IN (SELECT id FROM zz_ag)),
    'detail', v_30->'bikes');
  r := r || jsonb_build_object('step', 'D counts.with_smartphone_plan = agents who own a merchandise sale that has smartphone repayment schedules (not rejected)',
    'pass', (v_30#>>'{counts,with_smartphone_plan}')::bigint = (
      SELECT count(DISTINCT s.customer_id) FROM public.merchandise_sales s JOIN public.smartphone_repayment_schedules x ON x.sale_id = s.id
       WHERE COALESCE(s.order_status, '') <> 'rejected' AND s.customer_id IN (SELECT id FROM zz_ag)),
    'detail', v_30#>>'{counts,with_smartphone_plan}');
  r := r || jsonb_build_object('step', 'D counts.with_smartphone_tenants = agents with a tenant in the "recorded smartphone" group tops_smartphone_usage counts (tenant role, not deleted, has_smartphone)',
    'pass', (v_30#>>'{counts,with_smartphone_tenants}')::bigint = (
      SELECT count(DISTINCT q.aid) FROM zz_rr q JOIN public.profiles p ON p.id = q.tenant_id
       WHERE p.has_smartphone AND p.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM public.deleted_accounts d WHERE d.user_id = p.id AND d.status = 'soft_deleted' AND d.restored_at IS NULL AND d.purged_at IS NULL)
         AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role::text = 'tenant' AND ur.enabled)),
    'detail', v_30#>>'{counts,with_smartphone_tenants}');
  r := r || jsonb_build_object('step', 'D smartphone_usage is exactly what tops_smartphone_usage returns for the same days (never re-derived)',
    'pass', v_30->'smartphone_usage' = v_tops AND v_30#>>'{smartphone_usage,from_day}' = v_s::text AND v_30#>>'{smartphone_usage,to_day}' = v_today::text);
  r := r || jsonb_build_object('step', 'D counts.with_subagents = agents (in the set) with a verified link to a sub-agent who is also in the set',
    'pass', (v_30#>>'{counts,with_subagents}')::bigint = (
      SELECT count(DISTINCT s.parent_agent_id) FROM public.agent_subagents s
       WHERE s.status = 'verified' AND s.sub_agent_id IN (SELECT id FROM zz_ag) AND s.parent_agent_id IN (SELECT id FROM zz_ag)),
    'detail', v_30#>>'{counts,with_subagents}');

  -- the three top lists
  CREATE TEMP TABLE zz_port ON COMMIT DROP AS
    SELECT aid, sum(greatest(COALESCE(total_repayment, 0) - COALESCE(amount_repaid, 0), 0)) AS o, count(*) AS n FROM zz_rr
     WHERE status IN ('funded', 'repaying') AND COALESCE(tenancy_status, 'active') <> 'ended' GROUP BY aid;
  r := r || jsonb_build_object('step', 'D top_portfolios: the ten largest live-book portfolios, in order, with the direct outstanding and plan count',
    'pass', jsonb_array_length(v_30->'top_portfolios') = least(10, (SELECT count(*) FROM zz_port)) AND jsonb_array_length(v_30->'top_portfolios') > 0
        AND (SELECT bool_and((e->>'agent_id')::uuid = t.aid AND (e->>'portfolio')::numeric = round(t.o) AND (e->>'plans')::bigint = t.n)
               FROM (SELECT aid, o, n, row_number() OVER (ORDER BY o DESC, aid) AS rn FROM zz_port) t
               JOIN jsonb_array_elements(v_30->'top_portfolios') WITH ORDINALITY x(e, ord) ON t.rn = x.ord),
    'detail', (v_30->'top_portfolios'->0)::text);

  CREATE TEMP TABLE zz_rate ON COMMIT DROP AS
    SELECT p.agent_id AS aid, sum(p.expected_ugx) AS expected,
           COALESCE((SELECT sum(ac.amount) FROM public.agent_collections ac WHERE ac.agent_id = p.agent_id AND ac.reversed_at IS NULL AND ac.created_at >= v_start AND ac.created_at < v_end), 0) AS collected
      FROM public.agent_expected_day_plans p
     WHERE p.day BETWEEN v_s AND v_today AND p.agent_id IN (SELECT id FROM zz_ag)
     GROUP BY p.agent_id;
  r := r || jsonb_build_object('step', 'D top_collection_rate: ranked by non-reversed collections / pinned expected, only agents with expected >= 50,000, ten at most, in order',
    'pass', jsonb_array_length(v_30->'top_collection_rate') = least(10, (SELECT count(*) FROM zz_rate WHERE expected >= 50000 AND expected > 0))
        AND jsonb_array_length(v_30->'top_collection_rate') > 0
        AND (SELECT bool_and((e->>'agent_id')::uuid = t.aid AND (e->>'collected')::numeric = round(t.collected) AND (e->>'expected')::numeric = round(t.expected) AND (e->>'rate_pct')::numeric = round(100.0 * t.collected / t.expected, 1))
               FROM (SELECT aid, collected, expected, row_number() OVER (ORDER BY round(100.0 * collected / expected, 1) DESC, collected DESC, aid) AS rn FROM zz_rate WHERE expected >= 50000 AND expected > 0) t
               JOIN jsonb_array_elements(v_30->'top_collection_rate') WITH ORDINALITY x(e, ord) ON t.rn = x.ord),
    'detail', (v_30->'top_collection_rate'->0)::text);
  r := r || jsonb_build_object('step', 'D no ranked collection agent is under the minimum, and a huge minimum ranks nobody; a minimum of 0 ranks at least as many',
    'pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_30->'top_collection_rate') e WHERE (e->>'expected')::numeric < 50000)
        AND jsonb_array_length(v_hi->'top_collection_rate') = 0 AND jsonb_array_length(v_hi->'default_rate_ascending') = 0
        AND jsonb_array_length(v_lo->'top_collection_rate') >= jsonb_array_length(v_30->'top_collection_rate'));
  r := r || jsonb_build_object('step', 'D days_without_pin counts the range days that have no pinned plans (the function never pins them)',
    'pass', (v_30#>>'{range,days_without_pin}')::int = (SELECT count(*) FROM generate_series(v_s, v_today, interval '1 day') g(d) WHERE NOT EXISTS (SELECT 1 FROM public.agent_expected_day_plans p WHERE p.day = g.d::date)));

  CREATE TEMP TABLE zz_def ON COMMIT DROP AS
    SELECT q.aid, sum(greatest(COALESCE(q.total_repayment, 0) - COALESCE(q.amount_repaid, 0), 0)) AS outstanding,
           sum(least(greatest(COALESCE(a.arrears, 0), 0), greatest(COALESCE(q.total_repayment, 0) - COALESCE(q.amount_repaid, 0), 0))) AS defaulted
      FROM zz_rr q
      LEFT JOIN public._am_plan_arrears_core(ARRAY(SELECT id FROM zz_rr WHERE status IN ('funded', 'repaying') AND COALESCE(tenancy_status, 'active') <> 'ended'), v_today) a ON a.rent_request_id = q.id
     WHERE q.status IN ('funded', 'repaying') AND COALESCE(q.tenancy_status, 'active') <> 'ended'
     GROUP BY q.aid;
  r := r || jsonb_build_object('step', 'D default_rate_ascending: defaulted (payout-clock arrears, never above the plan''s outstanding) / outstanding, lowest first, only books of at least 50,000, ten at most',
    'pass', jsonb_array_length(v_30->'default_rate_ascending') = least(10, (SELECT count(*) FROM zz_def WHERE outstanding >= 50000 AND outstanding > 0))
        AND jsonb_array_length(v_30->'default_rate_ascending') > 0
        AND (SELECT bool_and((e->>'agent_id')::uuid = t.aid AND (e->>'outstanding')::numeric = round(t.outstanding) AND (e->>'defaulted')::numeric = round(t.defaulted) AND (e->>'default_rate_pct')::numeric = round(100.0 * t.defaulted / t.outstanding, 1))
               FROM (SELECT aid, outstanding, defaulted, row_number() OVER (ORDER BY round(100.0 * defaulted / outstanding, 1) ASC, outstanding DESC, aid) AS rn FROM zz_def WHERE outstanding >= 50000 AND outstanding > 0) t
               JOIN jsonb_array_elements(v_30->'default_rate_ascending') WITH ORDINALITY x(e, ord) ON t.rn = x.ord)
        AND (v_30#>>'{live_book,defaulted}')::numeric = (SELECT round(COALESCE(sum(defaulted), 0)) FROM zz_def),
    'detail', (v_30->'default_rate_ascending'->0)::text);
  r := r || jsonb_build_object('step', 'D default rates rise from the first row to the last',
    'pass', (SELECT bool_and((e->>'default_rate_pct')::numeric >= COALESCE(lag_v, 0)) FROM (SELECT e, lag((e->>'default_rate_pct')::numeric) OVER (ORDER BY ord) AS lag_v FROM jsonb_array_elements(v_30->'default_rate_ascending') WITH ORDINALITY x(e, ord)) s));
  r := r || jsonb_build_object('step', 'D every list row has agent_id, name, phone and whole-number UGX figures; every amount in the answer is a whole number',
    'pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements((v_30->'top_portfolios') || (v_30->'top_collection_rate') || (v_30->'default_rate_ascending')) e WHERE NOT (e ? 'agent_id' AND e ? 'name' AND e ? 'phone'))
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_30->'top_portfolios') e WHERE (e->>'portfolio') !~ '^\d+$')
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_30->'top_collection_rate') e WHERE (e->>'collected') !~ '^\d+$' OR (e->>'expected') !~ '^\d+$')
        AND (v_30#>>'{approved,amount}') ~ '^\d+$' AND (v_30#>>'{approved,receivables_outstanding}') ~ '^\d+$' AND (v_30#>>'{live_book,outstanding}') ~ '^\d+$');

  -- E. deleted accounts are left out everywhere (simulated inside this rolled-back test)
  v_drop := (v_30->'top_portfolios'->0->>'agent_id')::uuid;
  BEGIN
    UPDATE public.profiles SET deleted_at = now() WHERE id = v_drop;
    SET LOCAL ROLE authenticated;
    v_after := public.get_agent_ops_network_overview(v_today - 29, v_today);
    RESET ROLE;
    r := r || jsonb_build_object('step', 'E an agent whose profile is soft-deleted leaves the agent count, the live book and every list',
      'pass', (v_after#>>'{counts,agents}')::bigint = (v_30#>>'{counts,agents}')::bigint - 1
          AND (v_after#>>'{counts,posted_requests}')::bigint = (v_30#>>'{counts,posted_requests}')::bigint - 1
          AND (v_after#>>'{live_book,agents}')::bigint = (v_30#>>'{live_book,agents}')::bigint - 1
          AND NOT (v_after::text LIKE '%' || v_drop::text || '%'),
      'detail', v_drop::text);
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'E soft-deleted agent case ran', 'pass', false, 'detail', left(SQLERRM, 250)); END IF;
  END;
  BEGIN
    INSERT INTO public.deleted_accounts (user_id, status, reason) VALUES (v_drop, 'soft_deleted', 'test');
    SET LOCAL ROLE authenticated;
    v_after := public.get_agent_ops_network_overview(v_today - 29, v_today);
    RESET ROLE;
    r := r || jsonb_build_object('step', 'E an agent in deleted_accounts (soft_deleted, not restored) is left out the same way',
      'pass', (v_after#>>'{counts,agents}')::bigint = (v_30#>>'{counts,agents}')::bigint - 1 AND NOT (v_after::text LIKE '%' || v_drop::text || '%'));
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'E deleted_accounts case ran', 'pass', false, 'detail', left(SQLERRM, 250)); END IF;
  END;

  RAISE EXCEPTION 'ROLLED BACK REPORT: % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none');
END
$test$;

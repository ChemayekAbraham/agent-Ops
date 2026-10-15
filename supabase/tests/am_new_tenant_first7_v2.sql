-- Tests for 20261015180000_am_new_tenant_first7_v2.sql
-- (am_new_tenant_first7_v2, am_new_tenant_first7_summary_v2, am_new_tenant_first7_payments).
-- One transaction that always rolls back (the last statement raises with the report), so nothing is kept.
-- "ROLLED BACK REPORT: N passed of N | failing: none" is success.
--
-- The cases come from the live book (daily and weekly plans, part payments, reversed collections, days still to come). Nothing is written to
-- agent_collections: every figure the functions return is recomputed here, plan by plan, straight from landlord_payouts, rent_requests
-- and agent_collections and compared.
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_U uuid; v_role text; v_ok boolean; v_res jsonb; v_rows jsonb; v_pay jsonb; x jsonb; y jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_from date; v_to date; v_w int;
  v_rid uuid; v_d1 date; v_dt date; v_freq text; v_daily numeric; v_total numeric; v_first date; v_map jsonb; v_n int;
  v_p numeric; v_due numeric; v_st text; v_paid7 numeric; v_exp numeric; v_fpd int; v_rs text;
  v_rows_n int := 0; v_mis int := 0; v_mis_first text := ''; v_set_mis int := 0;
  v_part int := 0; v_future int := 0; v_missed int := 0; v_weekly int := 0; v_daily_n int := 0; v_rev_rows int := 0; v_rev_amt numeric; v_too_early int := 0;
  v_sample uuid[] := '{}'; v_agent uuid; v_cnt int; v_cnt2 int; v_sum numeric; v_sum2 numeric;
  v_wk jsonb; v_all jsonb; v_ids uuid[];
  windows int[][] := ARRAY[[30, 0], [20, 5], [8, 2], [3, 0]];  -- days back from today: p_from = today - a, p_to = today - b
BEGIN
  -- A. properties and grants
  r := r || jsonb_build_object('step', 'A the three functions are SECURITY DEFINER, STABLE, pinned to search_path = public',
    'pass', (SELECT count(*) = 3 AND bool_and(p.prosecdef AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=public'])
               FROM pg_proc p WHERE p.oid IN ('public.am_new_tenant_first7_v2(date,date,text,uuid)'::regprocedure,
                                              'public.am_new_tenant_first7_summary_v2(date,date,text,uuid)'::regprocedure,
                                              'public.am_new_tenant_first7_payments(uuid)'::regprocedure)));
  r := r || jsonb_build_object('step', 'A authenticated can execute all three; anon, service_role and PUBLIC cannot',
    'pass', (SELECT bool_and(has_function_privilege('authenticated', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE') AND NOT has_function_privilege('service_role', f, 'EXECUTE')
                             AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = f::regprocedure AND a.grantee = 0))
               FROM unnest(ARRAY['public.am_new_tenant_first7_v2(date,date,text,uuid)', 'public.am_new_tenant_first7_summary_v2(date,date,text,uuid)', 'public.am_new_tenant_first7_payments(uuid)']) f));
  r := r || jsonb_build_object('step', 'A the original am_new_tenant_first7 is still there, once, and still read-only',
    'pass', (SELECT count(*) = 1 AND bool_and(p.provolatile = 's') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'am_new_tenant_first7'));

  SELECT p.id INTO v_U FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) AND p.deleted_at IS NULL ORDER BY md5(p.id::text) LIMIT 1;

  -- B. the role gate (all three functions)
  FOREACH v_role IN ARRAY ARRAY['manager', 'super_admin', 'coo', 'ceo', 'cto', 'cfo', 'operations', 'tenant_ops', 'agent_ops', 'financial_ops'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      v_res := public.am_new_tenant_first7_summary_v2(v_today - 3, v_today);
      PERFORM 1 FROM public.am_new_tenant_first7_v2(v_today - 3, v_today) LIMIT 1;
      PERFORM 1 FROM public.am_new_tenant_first7_payments(gen_random_uuid());
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' can read all three', 'pass', (v_res->>'plans') IS NOT NULL);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' can read all three', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['landlord_ops', 'partner_ops', 'agent', 'tenant'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      v_ok := true;
      BEGIN PERFORM 1 FROM public.am_new_tenant_first7_v2(v_today - 3, v_today); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      BEGIN PERFORM public.am_new_tenant_first7_summary_v2(v_today - 3, v_today); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      BEGIN PERFORM 1 FROM public.am_new_tenant_first7_payments(gen_random_uuid()); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused by all three (42501)', 'pass', v_ok);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused by all three (42501)', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
  v_ok := true;
  BEGIN PERFORM 1 FROM public.am_new_tenant_first7_v2(v_today - 3, v_today); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  BEGIN PERFORM public.am_new_tenant_first7_summary_v2(v_today - 3, v_today); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  BEGIN PERFORM 1 FROM public.am_new_tenant_first7_payments(gen_random_uuid()); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'B a signed-in user with no role is refused by all three', 'pass', v_ok);
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := true;
  BEGIN PERFORM 1 FROM public.am_new_tenant_first7_v2(v_today - 3, v_today); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  BEGIN PERFORM public.am_new_tenant_first7_summary_v2(v_today - 3, v_today); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  BEGIN PERFORM 1 FROM public.am_new_tenant_first7_payments(gen_random_uuid()); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'B signed-out (no user) is refused by all three, before any argument is looked at', 'pass', v_ok);
  v_ok := true;
  BEGIN PERFORM 1 FROM public.am_new_tenant_first7_v2(NULL, NULL); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'B the gate comes before the range check (a signed-out call with NULL dates is 42501, not 22023)', 'pass', v_ok);
  BEGIN
    SET LOCAL ROLE anon;
    v_ok := true;
    BEGIN PERFORM 1 FROM public.am_new_tenant_first7_v2(v_today - 3, v_today); v_ok := false; EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN OTHERS THEN v_ok := false; END;
    BEGIN PERFORM public.am_new_tenant_first7_summary_v2(v_today - 3, v_today); v_ok := false; EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN OTHERS THEN v_ok := false; END;
    BEGIN PERFORM 1 FROM public.am_new_tenant_first7_payments(gen_random_uuid()); v_ok := false; EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN OTHERS THEN v_ok := false; END;
    RESET ROLE;
  END;
  r := r || jsonb_build_object('step', 'B the anon role cannot call any of them (permission denied)', 'pass', v_ok);

  -- from here on: a tenant_ops user
  INSERT INTO public.user_roles (user_id, role) VALUES (v_U, 'tenant_ops'::public.app_role);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);

  -- C. arguments
  v_ok := false; BEGIN PERFORM 1 FROM public.am_new_tenant_first7_v2(NULL, v_today); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'RANGE_REQUIRED%'; END;
  r := r || jsonb_build_object('step', 'C a missing start is refused (RANGE_REQUIRED)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM 1 FROM public.am_new_tenant_first7_v2(v_today, NULL); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'RANGE_REQUIRED%'; END;
  r := r || jsonb_build_object('step', 'C a missing end is refused (RANGE_REQUIRED)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM 1 FROM public.am_new_tenant_first7_v2(v_today, v_today - 1); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'RANGE_INVALID%'; END;
  r := r || jsonb_build_object('step', 'C an end before the start is refused (RANGE_INVALID)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM 1 FROM public.am_new_tenant_first7_v2(v_today - 31, v_today); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'RANGE_TOO_LARGE%'; END;
  r := r || jsonb_build_object('step', 'C 32 days is refused (RANGE_TOO_LARGE)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM 1 FROM public.am_new_tenant_first7_v2(v_today - 30, v_today); v_ok := true; EXCEPTION WHEN OTHERS THEN v_ok := false; END;
  r := r || jsonb_build_object('step', 'C exactly 31 days (both ends included) is allowed', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM public.am_new_tenant_first7_summary_v2(v_today - 31, v_today); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'RANGE_TOO_LARGE%'; END;
  r := r || jsonb_build_object('step', 'C the summary refuses the same ranges', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM 1 FROM public.am_new_tenant_first7_v2(v_today - 3, v_today, 'monthly'); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'FREQUENCY_INVALID%'; END;
  r := r || jsonb_build_object('step', 'C an unknown frequency is refused (FREQUENCY_INVALID)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM 1 FROM public.am_new_tenant_first7_payments(NULL); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'PLAN_REQUIRED%'; END;
  r := r || jsonb_build_object('step', 'C payments without a plan id is refused (PLAN_REQUIRED)', 'pass', v_ok);
  SELECT count(*) INTO v_cnt FROM public.am_new_tenant_first7_payments(gen_random_uuid());
  r := r || jsonb_build_object('step', 'C payments for an unknown plan is empty, not an error', 'pass', v_cnt = 0);

  -- D. every figure, plan by plan, over four windows (as the staff user, then recomputed as the table owner)
  FOR v_w IN 1..array_length(windows, 1) LOOP
    v_from := v_today - windows[v_w][1]; v_to := v_today - windows[v_w][2];
    SET LOCAL ROLE authenticated;
    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_rows FROM public.am_new_tenant_first7_v2(v_from, v_to) t;
    RESET ROLE;

    -- the set of plans: funded / repaying / completed, first landlord payout (Kampala day) in the range
    SELECT count(*) INTO v_cnt FROM (
      SELECT lp.rent_request_id FROM public.landlord_payouts lp JOIN public.rent_requests rr ON rr.id = lp.rent_request_id
       WHERE lp.status IN ('awaiting_agent_receipt', 'completed') AND rr.status IN ('funded', 'repaying', 'completed')
       GROUP BY lp.rent_request_id
      HAVING min((COALESCE(lp.finops_disbursed_at, lp.disbursed_at, lp.otp_verified_at) AT TIME ZONE 'Africa/Kampala')::date) BETWEEN v_from AND v_to) q;
    IF v_cnt <> jsonb_array_length(v_rows) THEN
      v_set_mis := v_set_mis + 1;
      v_mis_first := COALESCE(NULLIF(v_mis_first, ''), 'window ' || v_from || '..' || v_to || ': ' || jsonb_array_length(v_rows) || ' rows vs ' || v_cnt || ' plans');
    END IF;

    FOR x IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
      v_rows_n := v_rows_n + 1;
      v_rid := (x->>'rent_request_id')::uuid; v_d1 := (x->>'day1')::date;
      SELECT lower(COALESCE(rr.repayment_frequency, 'daily')), COALESCE(rr.daily_repayment, 0), COALESCE(rr.total_repayment, 0)
        INTO v_freq, v_daily, v_total FROM public.rent_requests rr WHERE rr.id = v_rid;
      SELECT min((COALESCE(lp.finops_disbursed_at, lp.disbursed_at, lp.otp_verified_at) AT TIME ZONE 'Africa/Kampala')::date) INTO v_first
        FROM public.landlord_payouts lp WHERE lp.rent_request_id = v_rid AND lp.status IN ('awaiting_agent_receipt', 'completed');
      SELECT COALESCE(jsonb_object_agg(d::text, s), '{}'::jsonb) INTO v_map FROM (
        SELECT (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS d, sum(ac.amount) AS s
          FROM public.agent_collections ac WHERE ac.rent_request_id = v_rid AND ac.reversed_at IS NULL GROUP BY 1) q;

      IF v_first IS DISTINCT FROM (x->>'landlord_paid_on')::date OR v_d1 <> v_first + 1 OR x->>'frequency' <> v_freq
         OR (x->>'daily_due')::numeric <> v_daily OR (x->>'total_repayment')::numeric <> v_total
         OR jsonb_array_length(x->'day_paid') <> 7 OR jsonb_array_length(x->'day_due') <> 7 OR jsonb_array_length(x->'day_state') <> 7 THEN
        v_mis := v_mis + 1; v_mis_first := COALESCE(NULLIF(v_mis_first, ''), 'plan ' || v_rid || ' header');
      END IF;
      IF v_freq = 'weekly' THEN v_weekly := v_weekly + 1; ELSE v_daily_n := v_daily_n + 1; END IF;

      v_paid7 := 0; v_exp := 0; v_fpd := NULL;
      FOR v_n IN 1..7 LOOP
        v_dt := v_first + v_n;
        v_p := COALESCE((v_map->>(v_dt::text))::numeric, 0);
        IF v_freq = 'weekly' THEN
          v_due := CASE WHEN v_n = 1 THEN (CASE WHEN v_total > 0 THEN least(v_daily * 7, v_total) ELSE v_daily * 7 END) ELSE 0 END;
        ELSE
          v_due := CASE WHEN v_total > 0 THEN greatest(0, least(v_daily, v_total - v_daily * (v_n - 1))) ELSE v_daily END;
        END IF;
        v_st := CASE WHEN v_dt > v_today THEN 'future' WHEN v_due = 0 THEN 'not_due' WHEN v_p >= v_due THEN 'paid' WHEN v_p > 0 THEN 'part' WHEN v_dt = v_today THEN 'future' ELSE 'missed' END;
        v_paid7 := v_paid7 + v_p;
        IF v_dt < v_today THEN v_exp := v_exp + v_due; END IF;
        IF v_p > 0 AND v_fpd IS NULL THEN v_fpd := v_n; END IF;
        IF (x->'day_paid'->>(v_n - 1))::numeric <> v_p OR (x->'day_due'->>(v_n - 1))::numeric <> v_due OR x->'day_state'->>(v_n - 1) <> v_st THEN
          v_mis := v_mis + 1; v_mis_first := COALESCE(NULLIF(v_mis_first, ''), 'plan ' || v_rid || ' day ' || v_n || ' got ' || (x->'day_paid'->>(v_n - 1)) || '/' || (x->'day_due'->>(v_n - 1)) || '/' || (x->'day_state'->>(v_n - 1)) || ' want ' || v_p || '/' || v_due || '/' || v_st);
        END IF;
        IF v_st = 'part' THEN v_part := v_part + 1; ELSIF v_st = 'future' THEN v_future := v_future + 1; ELSIF v_st = 'missed' THEN v_missed := v_missed + 1; END IF;
      END LOOP;
      v_rs := CASE WHEN v_d1 > v_today THEN 'too_early' WHEN v_fpd IS NULL THEN 'not_started' WHEN v_paid7 >= v_exp THEN 'on_track' ELSE 'behind' END;
      IF v_rs = 'too_early' THEN v_too_early := v_too_early + 1; END IF;
      IF (x->>'paid_7d')::numeric <> v_paid7 OR (x->>'expected_to_date')::numeric <> v_exp OR (x->>'first_paid_day')::int IS DISTINCT FROM v_fpd OR x->>'row_status' <> v_rs THEN
        v_mis := v_mis + 1; v_mis_first := COALESCE(NULLIF(v_mis_first, ''), 'plan ' || v_rid || ' totals got ' || (x->>'paid_7d') || '/' || (x->>'expected_to_date') || '/' || COALESCE(x->>'first_paid_day', 'null') || '/' || (x->>'row_status') || ' want ' || v_paid7 || '/' || v_exp || '/' || COALESCE(v_fpd::text, 'null') || '/' || v_rs);
      END IF;

      -- reversed collections are left out: the reversed ones inside the window would have changed the total
      SELECT COALESCE(sum(ac.amount), 0) INTO v_rev_amt FROM public.agent_collections ac
       WHERE ac.rent_request_id = v_rid AND ac.reversed_at IS NOT NULL AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_d1 AND v_d1 + 6;
      IF v_rev_amt > 0 THEN v_rev_rows := v_rev_rows + 1; END IF;
    END LOOP;
  END LOOP;
  r := r || jsonb_build_object('step', 'D the plans listed are exactly the funded / repaying / completed plans first paid to the landlord in the range (4 windows)', 'pass', v_set_mis = 0, 'detail', v_mis_first);
  r := r || jsonb_build_object('step', 'D every day paid / due / state and every row total, first paid day and status matches an independent recompute (' || v_rows_n || ' plan-windows)',
    'pass', v_rows_n > 0 AND v_mis = 0, 'detail', v_mis_first);
  r := r || jsonb_build_object('step', 'D coverage: daily plans, weekly plans, part-paid days, missed days and future days all occurred in the windows',
    'pass', v_daily_n > 0 AND v_weekly > 0 AND v_part > 0 AND v_missed > 0 AND v_future > 0,
    'detail', json_build_object('daily', v_daily_n, 'weekly', v_weekly, 'part', v_part, 'missed', v_missed, 'future', v_future, 'too_early', v_too_early)::text);
  r := r || jsonb_build_object('step', 'D coverage: plans with a reversed collection inside the window occurred (and the recompute that skips them matched)', 'pass', v_rev_rows > 0, 'detail', v_rev_rows::text);

  -- E. weekly shape and filters, on the widest window
  SET LOCAL ROLE authenticated;
  SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_all FROM public.am_new_tenant_first7_v2(v_today - 30, v_today) t;
  SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_wk FROM public.am_new_tenant_first7_v2(v_today - 30, v_today, ' Weekly ') t;
  RESET ROLE;
  SELECT count(*) INTO v_cnt FROM jsonb_array_elements(v_all) e WHERE e->>'frequency' = 'weekly';
  r := r || jsonb_build_object('step', 'E the weekly filter (case and spaces ignored) returns exactly the weekly rows, and only those',
    'pass', v_cnt > 0 AND v_cnt = jsonb_array_length(v_wk) AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_wk) e WHERE e->>'frequency' <> 'weekly'));
  r := r || jsonb_build_object('step', 'E a weekly plan owes 7 x daily on day 1 (never more than the total) and nothing on days 2 to 7',
    'pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_wk) e
                         WHERE (e->'day_due'->>0)::numeric <> least((e->>'daily_due')::numeric * 7, CASE WHEN (e->>'total_repayment')::numeric > 0 THEN (e->>'total_repayment')::numeric ELSE 1e18 END)
                            OR EXISTS (SELECT 1 FROM generate_series(1, 6) i WHERE (e->'day_due'->>i)::numeric <> 0)));
  SET LOCAL ROLE authenticated;
  SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_res FROM public.am_new_tenant_first7_v2(v_today - 30, v_today, 'daily') t;
  RESET ROLE;
  r := r || jsonb_build_object('step', 'E the daily filter returns the daily rows; daily + weekly = all', 'pass',
    jsonb_array_length(v_res) + jsonb_array_length(v_wk) = jsonb_array_length(v_all) AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res) e WHERE e->>'frequency' <> 'daily'));
  r := r || jsonb_build_object('step', 'E frequency comes from rent_requests.repayment_frequency (a plan with no value counts as daily)',
    'pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_all) e JOIN public.rent_requests rr ON rr.id = (e->>'rent_request_id')::uuid
                         WHERE e->>'frequency' <> lower(COALESCE(rr.repayment_frequency, 'daily'))));
  SELECT (e->>'agent_id')::uuid INTO v_agent FROM jsonb_array_elements(v_all) e WHERE e->>'agent_id' IS NOT NULL
   GROUP BY e->>'agent_id' ORDER BY count(*) DESC LIMIT 1;
  SET LOCAL ROLE authenticated;
  SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_res FROM public.am_new_tenant_first7_v2(v_today - 30, v_today, NULL, v_agent) t;
  RESET ROLE;
  SELECT count(*) INTO v_cnt FROM jsonb_array_elements(v_all) e WHERE (e->>'agent_id')::uuid = v_agent;
  r := r || jsonb_build_object('step', 'E the agent filter returns exactly that agent''s rows', 'pass', v_agent IS NOT NULL AND v_cnt > 0 AND v_cnt = jsonb_array_length(v_res)
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res) e WHERE (e->>'agent_id')::uuid IS DISTINCT FROM v_agent));
  r := r || jsonb_build_object('step', 'E the rows carry tenant, phone, agent and landlord paid date',
    'pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_all) e WHERE e->>'tenant_id' IS NULL OR e->>'landlord_paid_on' IS NULL OR e->>'day1' IS NULL)
        AND (SELECT count(*) FROM jsonb_array_elements(v_all) e WHERE e->>'tenant_name' IS NOT NULL) > 0
        AND (SELECT count(*) FROM jsonb_array_elements(v_all) e WHERE e->>'agent_name' IS NOT NULL) > 0);

  -- F. the summary is the same figures, added up
  FOR v_w IN 1..array_length(windows, 1) LOOP
    v_from := v_today - windows[v_w][1]; v_to := v_today - windows[v_w][2];
    SET LOCAL ROLE authenticated;
    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_rows FROM public.am_new_tenant_first7_v2(v_from, v_to) t;
    v_res := public.am_new_tenant_first7_summary_v2(v_from, v_to);
    RESET ROLE;
    v_ok :=
      (v_res->>'plans')::int = jsonb_array_length(v_rows)
      AND (v_res->>'daily_plans')::int = (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE e->>'frequency' = 'daily')
      AND (v_res->>'weekly_plans')::int = (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE e->>'frequency' = 'weekly')
      AND (v_res#>>'{status,on_track}')::int = (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE e->>'row_status' = 'on_track')
      AND (v_res#>>'{status,behind}')::int = (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE e->>'row_status' = 'behind')
      AND (v_res#>>'{status,not_started}')::int = (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE e->>'row_status' = 'not_started')
      AND (v_res#>>'{status,too_early}')::int = (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE e->>'row_status' = 'too_early')
      AND (v_res->>'collected')::numeric = COALESCE((SELECT sum((e->>'paid_7d')::numeric) FROM jsonb_array_elements(v_rows) e), 0)
      AND (v_res->>'expected')::numeric = COALESCE((SELECT sum((e->>'expected_to_date')::numeric) FROM jsonb_array_elements(v_rows) e), 0)
      AND jsonb_array_length(v_res->'per_day') = 7
      AND (v_res#>>'{day1,started}')::int = (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE (e->>'day1')::date <= v_today)
      AND (v_res#>>'{day1,payers}')::int = (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE (e->'day_paid'->>0)::numeric > 0)
      AND (v_res#>>'{day1,pct}') IS NOT DISTINCT FROM (SELECT CASE WHEN s > 0 THEN round(100.0 * p / s, 1)::text END
                                                        FROM (SELECT count(*) FILTER (WHERE (e->>'day1')::date <= v_today) AS s, count(*) FILTER (WHERE (e->'day_paid'->>0)::numeric > 0) AS p FROM jsonb_array_elements(v_rows) e) q);
    FOR v_n IN 1..7 LOOP
      y := v_res->'per_day'->(v_n - 1);
      v_ok := v_ok
        AND (y->>'day')::int = v_n
        AND (y->>'payers')::int = (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE (e->'day_paid'->>(v_n - 1))::numeric > 0)
        AND (y->>'started')::int = (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE (e->>'day1')::date + (v_n - 1) <= v_today)
        AND (y->>'paid_amount')::numeric = COALESCE((SELECT sum((e->'day_paid'->>(v_n - 1))::numeric) FROM jsonb_array_elements(v_rows) e), 0)
        AND (y->>'due_amount')::numeric = COALESCE((SELECT sum((e->'day_due'->>(v_n - 1))::numeric) FROM jsonb_array_elements(v_rows) e WHERE (e->>'day1')::date + (v_n - 1) <= v_today), 0)
        AND (y#>>'{states,paid}')::int = (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE e->'day_state'->>(v_n - 1) = 'paid')
        AND (y#>>'{states,part}')::int = (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE e->'day_state'->>(v_n - 1) = 'part')
        AND (y#>>'{states,missed}')::int = (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE e->'day_state'->>(v_n - 1) = 'missed')
        AND (y#>>'{states,not_due}')::int = (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE e->'day_state'->>(v_n - 1) = 'not_due')
        AND (y#>>'{states,future}')::int = (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE e->'day_state'->>(v_n - 1) = 'future');
    END LOOP;
    r := r || jsonb_build_object('step', 'F summary for ' || v_from || '..' || v_to || ': headline counts, day-1 count and %, per-day payers and collected vs expected equal the rows added up', 'pass', v_ok,
      'detail', left(v_res::text, 300));
  END LOOP;
  SET LOCAL ROLE authenticated;
  v_res := public.am_new_tenant_first7_summary_v2(v_today - 30, v_today, 'weekly');
  RESET ROLE;
  r := r || jsonb_build_object('step', 'F the summary takes the same filters (weekly: only weekly plans, no daily)', 'pass',
    (v_res->>'plans')::int = jsonb_array_length(v_wk) AND (v_res->>'daily_plans')::int = 0 AND (v_res->>'weekly_plans')::int = jsonb_array_length(v_wk));
  SET LOCAL ROLE authenticated;
  v_res := public.am_new_tenant_first7_summary_v2(v_today + 100, v_today + 110);
  RESET ROLE;
  r := r || jsonb_build_object('step', 'F an empty range gives zeros, no days and no percentages (not an error)', 'pass',
    (v_res->>'plans')::int = 0 AND (v_res->>'collected')::numeric = 0 AND (v_res->>'expected')::numeric = 0 AND jsonb_array_length(v_res->'per_day') = 0
    AND (v_res->>'collected_pct') IS NULL AND (v_res#>>'{day1,pct}') IS NULL AND (v_res#>>'{day1,payers}')::int = 0);

  -- G. payments: every collection in the window, same gate, same totals as the rows
  SELECT array_agg(rid) INTO v_sample FROM (
    SELECT (e->>'rent_request_id')::uuid AS rid FROM jsonb_array_elements(v_all) e
     ORDER BY (EXISTS (SELECT 1 FROM public.agent_collections ac WHERE ac.rent_request_id = (e->>'rent_request_id')::uuid AND ac.reversed_at IS NOT NULL)) DESC, md5(e->>'rent_request_id') LIMIT 40) q;
  SET LOCAL ROLE authenticated;
  SELECT COALESCE(jsonb_object_agg(s::text, (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.collected_at, p.collection_id), '[]'::jsonb) FROM public.am_new_tenant_first7_payments(s) p)), '{}'::jsonb)
    INTO v_pay FROM unnest(v_sample) s;
  RESET ROLE;
  v_ok := true; v_mis := 0; v_mis_first := ''; v_cnt2 := 0;
  FOR x IN SELECT value FROM jsonb_array_elements(v_all) e(value) WHERE (value->>'rent_request_id')::uuid = ANY (v_sample) LOOP
    v_rid := (x->>'rent_request_id')::uuid; v_d1 := (x->>'day1')::date;
    SELECT count(*), COALESCE(sum(ac.amount), 0) INTO v_cnt, v_sum FROM public.agent_collections ac
     WHERE ac.rent_request_id = v_rid AND ac.reversed_at IS NULL AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_d1 AND v_d1 + 6;
    SELECT count(*), COALESCE(sum((p->>'amount')::numeric), 0) INTO v_cnt2, v_sum2 FROM jsonb_array_elements(v_pay->(v_rid::text)) p;
    IF v_cnt <> v_cnt2 OR v_sum <> v_sum2 OR v_sum2 <> (x->>'paid_7d')::numeric
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_pay->(v_rid::text)) p WHERE (p->>'day_number')::int NOT BETWEEN 1 AND 7 OR (p->>'collected_day')::date <> ((p->>'collected_at')::timestamptz AT TIME ZONE 'Africa/Kampala')::date
                                                                                  OR (p->>'collected_day')::date - (x->>'landlord_paid_on')::date <> (p->>'day_number')::int
                                                                                  OR (p->>'collected_at') IS NULL OR (p->>'amount') IS NULL)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_pay->(v_rid::text)) p JOIN public.agent_collections ac ON ac.id = (p->>'collection_id')::uuid WHERE ac.reversed_at IS NOT NULL OR ac.rent_request_id <> v_rid) THEN
      v_ok := false; v_mis := v_mis + 1; v_mis_first := COALESCE(NULLIF(v_mis_first, ''), 'plan ' || v_rid || ' ' || v_cnt || '/' || v_cnt2 || ' ' || v_sum || '/' || v_sum2 || ' paid_7d ' || (x->>'paid_7d'));
    END IF;
  END LOOP;
  r := r || jsonb_build_object('step', 'G payments: for ' || COALESCE(array_length(v_sample, 1), 0) || ' plans (reversed-collection plans first) the same collections, count and total as the day grid, none reversed, day numbers 1 to 7', 'pass', v_ok AND COALESCE(array_length(v_sample, 1), 0) > 0, 'detail', v_mis_first);
  r := r || jsonb_build_object('step', 'G payments are in time order and carry the method and the agent',
    'pass', NOT EXISTS (SELECT 1 FROM jsonb_each(v_pay) k(rid, arr), jsonb_array_elements(arr) WITH ORDINALITY a(p, i)
                         WHERE i > 1 AND (p->>'collected_at')::timestamptz < ((arr->((i - 2)::int))->>'collected_at')::timestamptz)
        AND (SELECT count(*) FROM jsonb_each(v_pay) k(rid, arr), jsonb_array_elements(arr) p WHERE p->>'payment_method' IS NOT NULL) > 0
        AND (SELECT count(*) FROM jsonb_each(v_pay) k(rid, arr), jsonb_array_elements(arr) p WHERE p->>'agent_name' IS NOT NULL) > 0);

  -- H. read-only
  r := r || jsonb_build_object('step', 'H nothing was written: all three are STABLE and no collection or payout was touched in this test',
    'pass', (SELECT bool_and(p.provolatile = 's') FROM pg_proc p WHERE p.proname LIKE 'am_new_tenant_first7%' AND p.pronamespace = 'public'::regnamespace));

  RAISE EXCEPTION 'ROLLED BACK REPORT: % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none');
END
$test$;

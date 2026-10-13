-- Rolled-back verification for 20261013220000_tenant_ops_no_payment_threshold.sql
--
-- Run against the live database. Read-only: nothing is written. There are two blocks (each report call takes a few
-- seconds, so one block would be too long); each ends in RAISE EXCEPTION so the error text IS the report (steps
-- with "pass"). Every step must pass.
--
-- Block 1
--   A  access: each new function lets in exactly the roles its original lets in; signed-out and no-role refused;
--      anon cannot call them; the helper is not callable from the API
--   B  parity: with p_min_days = 20 the v2 report equals get_tenant_ops_no_payment_report (every tenant and field,
--      the counts and the agent breakdown, also with an agent filter); the default is 20
-- Block 2
--   C  edge values: 1 and 365 work; 0, 366, -5 and NULL are refused (v2 and the payout-clock variant)
--   D  the bands are monotonic (N+ >= N+10 >= N+20) and agree with the report at N+10 / N+20; raising N never adds
--      tenants; v2 at 7, 20 and 45 equals the widest list (N = 1) cut at that N
--   E  landlord-not-paid plans are never counted by the payout-clock variant
--   F  the payout-clock variant equals the open week's live 20+ days figure at N = 20, plan for plan
--   G  nothing else moved: the original report, the weekly / pin functions and the functions behind Agent Monitoring,
--      Top-Up Eligibility and Weekly Performance are byte-for-byte as before; the frozen weeks are unchanged by running
--      the new functions; the new functions are STABLE

-- ===== Block 1: A and B =====
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_role text;
  v_user uuid;
  v_staff uuid;
  v_plain uuid;
  v_ok boolean;
  v_gate_v2 boolean; v_gate_dm boolean;
  v_orig jsonb; v_v2 jsonb; v_a jsonb; v_b jsonb;
  n_a int; n_b int;
  v_agent uuid;
BEGIN
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'operations' AND enabled LIMIT 1;
  SELECT p.id INTO v_plain FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) LIMIT 1;

  -- A: access. An invalid p_min_days is checked AFTER the staff gate, so SQLSTATE 22023 means "let in" and
  -- anything else means "refused". The originals' gates: the report = is_ops_role (manager, super_admin, coo,
  -- operations) + cto, ceo, cfo; the weekly figure = the same without cfo.
  FOREACH v_role IN ARRAY ARRAY['manager','super_admin','coo','ceo','cto','cfo','operations','tenant_ops','agent_ops','financial_ops'] LOOP
    -- the user holding this role with the fewest other roles (a user can hold several)
    SELECT ur.user_id INTO v_user FROM public.user_roles ur WHERE ur.role::text = v_role AND ur.enabled
     ORDER BY (SELECT count(*) FROM public.user_roles u2 WHERE u2.user_id = ur.user_id AND u2.enabled), ur.user_id LIMIT 1;
    IF v_user IS NULL THEN
      r := r || jsonb_build_object('step', 'A role ' || v_role, 'pass', NULL, 'detail', 'skipped: no enabled user holds this role');
      CONTINUE;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    v_gate_v2 := false; v_gate_dm := false;
    BEGIN PERFORM public.get_tenant_ops_no_payment_report_v2(0, NULL); EXCEPTION WHEN OTHERS THEN v_gate_v2 := SQLSTATE = '22023'; END;
    BEGIN PERFORM public.get_tenant_ops_dormant_amclock(0); EXCEPTION WHEN OTHERS THEN v_gate_dm := SQLSTATE = '22023'; END;
    r := r || jsonb_build_object('step', 'A role ' || v_role || ': the report and the weekly variant let in exactly the roles their originals let in',
      'pass', v_gate_v2 = EXISTS (SELECT 1 FROM public.user_roles x WHERE x.user_id = v_user AND x.enabled
                                    AND x.role::text IN ('manager','super_admin','coo','operations','cto','ceo','cfo'))
          AND v_gate_dm = EXISTS (SELECT 1 FROM public.user_roles x WHERE x.user_id = v_user AND x.enabled
                                    AND x.role::text IN ('manager','super_admin','coo','operations','cto','ceo')),
      'detail', jsonb_build_object('report', v_gate_v2, 'weekly_variant', v_gate_dm,
                                   'roles_held', (SELECT jsonb_agg(x.role::text) FROM public.user_roles x WHERE x.user_id = v_user AND x.enabled)));
  END LOOP;

  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false;
  BEGIN PERFORM public.get_tenant_ops_no_payment_report_v2(20, NULL); EXCEPTION WHEN OTHERS THEN v_ok := true; END;
  r := r || jsonb_build_object('step', 'A signed-out call refused (v2)', 'pass', v_ok);
  v_ok := false;
  BEGIN PERFORM public.get_tenant_ops_dormant_amclock(20); EXCEPTION WHEN OTHERS THEN v_ok := true; END;
  r := r || jsonb_build_object('step', 'A signed-out call refused (payout-clock variant)', 'pass', v_ok);
  IF v_plain IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_plain, 'role', 'authenticated')::text, true);
    v_ok := false;
    BEGIN PERFORM public.get_tenant_ops_no_payment_report_v2(20, NULL); EXCEPTION WHEN OTHERS THEN v_ok := true; END;
    r := r || jsonb_build_object('step', 'A a user without a role is refused (v2)', 'pass', v_ok);
  END IF;
  r := r || jsonb_build_object('step', 'A anon cannot call the new functions; authenticated can; the helper is internal',
    'pass', NOT has_function_privilege('anon', 'public.get_tenant_ops_no_payment_report_v2(integer,uuid)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.get_tenant_ops_dormant_amclock(integer)', 'EXECUTE')
        AND has_function_privilege('authenticated', 'public.get_tenant_ops_no_payment_report_v2(integer,uuid)', 'EXECUTE')
        AND has_function_privilege('authenticated', 'public.get_tenant_ops_dormant_amclock(integer)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public._tenant_ops_dormant_days_amclock()', 'EXECUTE'));

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);

  -- B: parity at 20 ---------------------------------------------------------------------------
  v_orig := public.get_tenant_ops_no_payment_report(NULL);
  v_v2 := public.get_tenant_ops_no_payment_report_v2(20, NULL);
  SELECT count(*) INTO n_a FROM (SELECT t FROM jsonb_array_elements(v_orig->'tenants') t EXCEPT SELECT t FROM jsonb_array_elements(v_v2->'tenants') t) q;
  SELECT count(*) INTO n_b FROM (SELECT t FROM jsonb_array_elements(v_v2->'tenants') t EXCEPT SELECT t FROM jsonb_array_elements(v_orig->'tenants') t) q;
  r := r || jsonb_build_object('step', 'B v2 at 20 returns exactly the same tenants (every field) as the original',
    'pass', n_a = 0 AND n_b = 0 AND jsonb_array_length(v_orig->'tenants') = jsonb_array_length(v_v2->'tenants')
        AND jsonb_array_length(v_v2->'tenants') > 0,
    'detail', jsonb_build_object('tenants', jsonb_array_length(v_v2->'tenants'), 'only_in_original', n_a, 'only_in_v2', n_b));
  r := r || jsonb_build_object('step', 'B the total and the day equal the original',
    'pass', (v_orig->>'total_20_plus')::int = (v_v2->>'total_min_days')::int AND v_orig->>'as_of' = v_v2->>'as_of'
        AND (v_v2->>'min_days')::int = 20);
  SELECT count(*) INTO n_a FROM (
    SELECT (a->>'agent_id') AS agent_id, a->>'label' AS label, (a->>'gte_20')::int AS n1, (a->>'gte_30')::int AS n2, (a->>'gte_40')::int AS n3
      FROM jsonb_array_elements(v_orig->'agent_summary') a
    EXCEPT
    SELECT (a->>'agent_id'), a->>'label', (a->>'gte_min')::int, (a->>'gte_min_10')::int, (a->>'gte_min_20')::int
      FROM jsonb_array_elements(v_v2->'agent_summary') a) q;
  SELECT count(*) INTO n_b FROM (
    SELECT (a->>'agent_id'), a->>'label', (a->>'gte_min')::int, (a->>'gte_min_10')::int, (a->>'gte_min_20')::int
      FROM jsonb_array_elements(v_v2->'agent_summary') a
    EXCEPT
    SELECT (a->>'agent_id'), a->>'label', (a->>'gte_20')::int, (a->>'gte_30')::int, (a->>'gte_40')::int
      FROM jsonb_array_elements(v_orig->'agent_summary') a) q;
  r := r || jsonb_build_object('step', 'B the per-agent breakdown at 20 / 30 / 40 equals N / N+10 / N+20 at 20',
    'pass', n_a = 0 AND n_b = 0 AND jsonb_array_length(v_v2->'agent_summary') = jsonb_array_length(v_orig->'agent_summary'),
    'detail', jsonb_build_object('agents', jsonb_array_length(v_v2->'agent_summary')));
  v_agent := (SELECT (a->>'agent_id')::uuid FROM jsonb_array_elements(v_orig->'agent_summary') a WHERE a->>'agent_id' IS NOT NULL ORDER BY (a->>'gte_20')::int DESC LIMIT 1);
  v_a := public.get_tenant_ops_no_payment_report(v_agent);
  v_b := public.get_tenant_ops_no_payment_report_v2(20, v_agent);
  SELECT count(*) INTO n_a FROM (SELECT t FROM jsonb_array_elements(v_a->'tenants') t EXCEPT SELECT t FROM jsonb_array_elements(v_b->'tenants') t) q;
  SELECT count(*) INTO n_b FROM (SELECT t FROM jsonb_array_elements(v_b->'tenants') t EXCEPT SELECT t FROM jsonb_array_elements(v_a->'tenants') t) q;
  r := r || jsonb_build_object('step', 'B the agent filter returns the same tenants as the original, and the breakdown still covers every agent',
    'pass', n_a = 0 AND n_b = 0 AND (v_a->>'total_20_plus')::int = (v_b->>'total_min_days')::int
        AND jsonb_array_length(v_b->'agent_summary') = jsonb_array_length(v_v2->'agent_summary'));
  r := r || jsonb_build_object('step', 'B the default is 20',
    'pass', public.get_tenant_ops_no_payment_report_v2() = v_v2 AND (public.get_tenant_ops_dormant_amclock()->>'min_days')::int = 20);

  RAISE EXCEPTION 'ROLLED BACK REPORT (block 1): %', jsonb_pretty(r);
END
$test$;

-- ===== Block 2: C, D, E, F and G =====
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_staff uuid;
  v_ok boolean;
  v_ws date; v_we date;
  n_a int; n_b int; n_c int;
  v_n int;
  v_bad text := '';
  v_live uuid[];
  v_md5_old_before text; v_md5_old_after text; v_md5_new_before text; v_md5_new_after text;
  v_w jsonb; v_x jsonb;
  c_frozen_md5 constant text := '70fd057d2d392305aa547ff0bed483a8';
BEGIN
  SELECT period_start, period_end INTO v_ws, v_we FROM public.tppo_period_bounds('week', v_today);
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'operations' AND enabled LIMIT 1;
  SELECT ARRAY(SELECT id FROM public.rent_requests WHERE status IN ('funded', 'disbursed', 'repaying')) INTO v_live;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);

  SELECT md5(string_agg(t::text, '|' ORDER BY week_start)) INTO v_md5_old_before FROM public.tenant_ops_weekly_metrics t;
  SELECT md5(string_agg(t::text, '|' ORDER BY week_start)) INTO v_md5_new_before FROM public.tenant_ops_weekly_metrics_amclock t;

  -- C: edge values ----------------------------------------------------------------------------
  FOREACH v_n IN ARRAY ARRAY[0, 366, -5] LOOP
    v_ok := false;
    BEGIN PERFORM public.get_tenant_ops_no_payment_report_v2(v_n, NULL); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023'; END;
    v_bad := v_bad || CASE WHEN v_ok THEN '' ELSE ' v2:' || v_n END;
    v_ok := false;
    BEGIN PERFORM public.get_tenant_ops_dormant_amclock(v_n); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023'; END;
    v_bad := v_bad || CASE WHEN v_ok THEN '' ELSE ' dormant:' || v_n END;
  END LOOP;
  v_ok := false;
  BEGIN PERFORM public.get_tenant_ops_no_payment_report_v2(NULL, NULL); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023'; END;
  v_bad := v_bad || CASE WHEN v_ok THEN '' ELSE ' v2:null' END;
  v_ok := false;
  BEGIN PERFORM public.get_tenant_ops_dormant_amclock(NULL); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023'; END;
  v_bad := v_bad || CASE WHEN v_ok THEN '' ELSE ' dormant:null' END;
  r := r || jsonb_build_object('step', 'C 0, 366, -5 and NULL are refused by both functions with a clear error', 'pass', v_bad = '', 'detail', v_bad);

  -- the widest list (N = 1) and the narrowest (N = 365), straight from the function
  CREATE TEMP TABLE _w1 ON COMMIT DROP AS SELECT public.get_tenant_ops_no_payment_report_v2(1, NULL) AS j;
  CREATE TEMP TABLE _w365 ON COMMIT DROP AS SELECT public.get_tenant_ops_no_payment_report_v2(365, NULL) AS j;
  SELECT j INTO v_w FROM _w1;
  SELECT j INTO v_x FROM _w365;
  r := r || jsonb_build_object('step', 'C N = 1 and N = 365 work: every row is at least 1 / 365 days, and the total equals the rows',
    'pass', (v_w->>'min_days')::int = 1 AND (v_x->>'min_days')::int = 365
        AND (v_w->>'total_min_days')::int = jsonb_array_length(v_w->'tenants')
        AND (v_x->>'total_min_days')::int = jsonb_array_length(v_x->'tenants')
        AND (v_w->>'total_min_days')::int >= (v_x->>'total_min_days')::int
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_w->'tenants') t WHERE (t->>'days_since_last_payment')::int < 1)
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'tenants') t WHERE (t->>'days_since_last_payment')::int < 365),
    'detail', jsonb_build_object('n1', v_w->'total_min_days', 'n365', v_x->'total_min_days'));
  r := r || jsonb_build_object('step', 'C N = 1 and N = 365 work on the payout-clock variant',
    'pass', (public.get_tenant_ops_dormant_amclock(1)->>'count')::int >= (public.get_tenant_ops_dormant_amclock(20)->>'count')::int
        AND (public.get_tenant_ops_dormant_amclock(365)->>'count')::int <= (public.get_tenant_ops_dormant_amclock(20)->>'count')::int);

  -- D: bands. v2 at 7, 20 and 45 must equal the N = 1 list cut at that N, and its bands must equal that list cut at N+10 / N+20.
  v_bad := '';
  FOREACH v_n IN ARRAY ARRAY[7, 20, 45] LOOP
    v_x := public.get_tenant_ops_no_payment_report_v2(v_n, NULL);
    SELECT COALESCE(sum((a->>'gte_min')::int), 0), COALESCE(sum((a->>'gte_min_10')::int), 0), COALESCE(sum((a->>'gte_min_20')::int), 0)
      INTO n_a, n_b, n_c FROM jsonb_array_elements(v_x->'agent_summary') a;
    IF NOT (n_a >= n_b AND n_b >= n_c AND n_a = (v_x->>'total_min_days')::int) THEN
      v_bad := v_bad || ' ' || v_n || '(bands)';
    END IF;
    IF n_a <> (SELECT count(*) FROM jsonb_array_elements(v_w->'tenants') t WHERE (t->>'days_since_last_payment')::int >= v_n)
       OR n_b <> (SELECT count(*) FROM jsonb_array_elements(v_w->'tenants') t WHERE (t->>'days_since_last_payment')::int >= v_n + 10)
       OR n_c <> (SELECT count(*) FROM jsonb_array_elements(v_w->'tenants') t WHERE (t->>'days_since_last_payment')::int >= v_n + 20) THEN
      v_bad := v_bad || ' ' || v_n || '(cut)';
    END IF;
    IF (SELECT count(*) FROM (
          SELECT t->>'tenant_id' FROM jsonb_array_elements(v_x->'tenants') t
          EXCEPT SELECT t->>'tenant_id' FROM jsonb_array_elements(v_w->'tenants') t WHERE (t->>'days_since_last_payment')::int >= v_n) q) <> 0
       OR (SELECT count(*) FROM (
          SELECT t->>'tenant_id' FROM jsonb_array_elements(v_w->'tenants') t WHERE (t->>'days_since_last_payment')::int >= v_n
          EXCEPT SELECT t->>'tenant_id' FROM jsonb_array_elements(v_x->'tenants') t) q) <> 0 THEN
      v_bad := v_bad || ' ' || v_n || '(tenants)';
    END IF;
  END LOOP;
  r := r || jsonb_build_object('step', 'D bands are monotonic (N+ >= N+10 >= N+20) and the report at 7, 20 and 45 equals the widest list cut at that N, its bands cut at N+10 / N+20',
    'pass', v_bad = '', 'detail', v_bad);

  v_bad := '';
  FOREACH v_n IN ARRAY ARRAY[1, 7, 14, 20, 30, 45, 60, 120, 340] LOOP
    v_x := public.get_tenant_ops_dormant_amclock(v_n);
    IF NOT ((v_x->>'count')::int >= (v_x->>'count_plus_10')::int AND (v_x->>'count_plus_10')::int >= (v_x->>'count_plus_20')::int
            AND (v_n + 10 > 365 OR (v_x->>'count_plus_10')::int = (public.get_tenant_ops_dormant_amclock(v_n + 10)->>'count')::int)
            AND (v_n + 20 > 365 OR (v_x->>'count_plus_20')::int = (public.get_tenant_ops_dormant_amclock(v_n + 20)->>'count')::int)) THEN
      v_bad := v_bad || ' ' || v_n;
    END IF;
  END LOOP;
  r := r || jsonb_build_object('step', 'D the same holds for the payout-clock variant: monotonic bands, and N+10 / N+20 at N equal N at N+10 / N+20', 'pass', v_bad = '', 'detail', v_bad);
  SELECT count(*) INTO n_a FROM (
    SELECT n, (public.get_tenant_ops_dormant_amclock(n)->>'count')::int AS c,
           lag((public.get_tenant_ops_dormant_amclock(n)->>'count')::int) OVER (ORDER BY n) AS prev
      FROM unnest(ARRAY[1, 7, 14, 20, 30, 45, 60]) n) q WHERE prev IS NOT NULL AND c > prev;
  r := r || jsonb_build_object('step', 'D raising N never adds plans on the payout-clock variant (presets 1, 7, 14, 20, 30, 45, 60)', 'pass', n_a = 0);

  -- E: landlord-not-paid never counted ------------------------------------------------------------------
  CREATE TEMP TABLE _h ON COMMIT DROP AS SELECT * FROM public._tenant_ops_dormant_days_amclock();
  SELECT count(*) INTO n_a FROM _h d WHERE d.bucket IN ('tenant_paying_no_landlord', 'awaiting_landlord') AND (d.counted OR d.days_since IS NOT NULL);
  SELECT count(*) INTO n_b FROM _h d WHERE d.bucket IN ('tenant_paying_no_landlord', 'awaiting_landlord');
  r := r || jsonb_build_object('step', 'E plans with no counted landlord payout are never counted (payout-clock variant)',
    'pass', n_a = 0 AND n_b > 0
        AND (public.get_tenant_ops_dormant_amclock(1)->>'count')::int = (SELECT count(*) FROM _h d WHERE d.counted AND d.days_since >= 1),
    'detail', jsonb_build_object('landlord_not_paid_plans', n_b, 'counted_wrongly', n_a));
  SELECT count(*) INTO n_c FROM jsonb_array_elements(v_w->'tenants') t
    JOIN public.rent_requests rr ON rr.tenant_id = (t->>'tenant_id')::uuid AND rr.status IN ('funded', 'repaying')
    JOIN public._am_plan_clock_core(v_live) k ON k.rent_request_id = rr.id AND k.bucket IN ('tenant_paying_no_landlord', 'awaiting_landlord');
  r := r || jsonb_build_object('step', 'E info: tenants in the original-gate report (N = 1) on a plan the payout clock does not cover; kept as the original has them',
    'pass', NULL, 'detail', jsonb_build_object('tenants', n_c));

  -- F: the payout-clock variant equals the open week's live figure at 20 -----------------------------------
  SELECT count(*) INTO n_a FROM (
    SELECT d.rent_request_id FROM _h d WHERE d.days_since >= 20
    EXCEPT SELECT p.rent_request_id FROM public._tenant_ops_weekly_amclock_plans(v_ws, v_we) p WHERE p.dormant) q;
  SELECT count(*) INTO n_b FROM (
    SELECT p.rent_request_id FROM public._tenant_ops_weekly_amclock_plans(v_ws, v_we) p WHERE p.dormant
    EXCEPT SELECT d.rent_request_id FROM _h d WHERE d.days_since >= 20) q;
  r := r || jsonb_build_object('step', 'F at N = 20 the payout-clock variant counts exactly the plans the open week counts as 20+ days, and the same totals',
    'pass', n_a = 0 AND n_b = 0
        AND (public.get_tenant_ops_dormant_amclock(20)->>'count')::int = (SELECT dormant_20_plus_count FROM public._tenant_ops_weekly_metrics_raw_amclock(v_ws, v_we))
        AND (public.get_tenant_ops_dormant_amclock(20)->>'landlord_not_paid_count')::int = (SELECT landlord_not_paid_count FROM public._tenant_ops_weekly_metrics_raw_amclock(v_ws, v_we)),
    'detail', jsonb_build_object('count_at_20', public.get_tenant_ops_dormant_amclock(20)->'count', 'only_in_variant', n_a, 'only_in_weekly', n_b));

  -- G: nothing else moved ----------------------------------------------------------------------------------
  SELECT md5(string_agg(t::text, '|' ORDER BY week_start)) INTO v_md5_old_after FROM public.tenant_ops_weekly_metrics t;
  SELECT md5(string_agg(t::text, '|' ORDER BY week_start)) INTO v_md5_new_after FROM public.tenant_ops_weekly_metrics_amclock t;
  r := r || jsonb_build_object('step', 'G the frozen weekly rows are identical before and after (row hash); weeks before 7 Oct 2026 equal the hash taken before the earlier migrations',
    'pass', v_md5_old_before IS NOT DISTINCT FROM v_md5_old_after AND v_md5_new_before IS NOT DISTINCT FROM v_md5_new_after
        AND (SELECT md5(string_agg(t::text, '|' ORDER BY week_start)) FROM public.tenant_ops_weekly_metrics t WHERE week_start < DATE '2026-10-07') = c_frozen_md5);
  r := r || jsonb_build_object('step', 'G the original report, the weekly plan logic and the pin jobs are byte-for-byte as before (function hashes)',
    'pass',
      (SELECT md5(pg_get_functiondef('public.get_tenant_ops_no_payment_report(uuid)'::regprocedure))) = '82525804c4d54ceaff6853a9d3b6516d'
      AND (SELECT md5(pg_get_functiondef('public._tenant_ops_weekly_amclock_plans(date,date)'::regprocedure))) = '1cb66b3b74723f270f68906b138a8109'
      AND (SELECT md5(pg_get_functiondef('public._tenant_ops_weekly_metrics_raw_amclock(date,date)'::regprocedure))) = '871924734357e5aca2891063cd421151'
      AND (SELECT md5(pg_get_functiondef('public._tenant_ops_weekly_metrics_raw(date,date)'::regprocedure))) = 'f242d16cecb7c7e153576af8cc4918b3'
      AND (SELECT md5(pg_get_functiondef('public.pin_tenant_ops_weekly_metrics(date)'::regprocedure))) = '402d048920f5b546c06f9b03cf5bb1dd'
      AND (SELECT md5(pg_get_functiondef('public.pin_tenant_ops_weekly_metrics_amclock(date)'::regprocedure))) = '2c303f7407c219f3fc7bcd77fbc2f7e0'
      AND (SELECT md5(pg_get_functiondef('public.pin_tenant_ops_weekly_metrics_amclock_catchup(integer)'::regprocedure))) = '23b91a85d8a520e1c2bf5d0e1b598e17');
  -- Live figures (collections, new plans) move every minute, so a before/after comparison of money figures is not
  -- reliable on live data. What proves the other pages are untouched is that their code is byte-for-byte as before,
  -- and that the new functions are STABLE (they cannot write).
  r := r || jsonb_build_object('step', 'G the functions behind Agent Monitoring, Top-Up Eligibility and Weekly Performance are byte-for-byte as before (function hashes); the new functions are STABLE and cannot write',
    'pass',
      (SELECT md5(pg_get_functiondef('public.get_tenant_topup_eligibility(text,uuid,text,integer,integer)'::regprocedure))) = '79228e83c891bd511ab82125fd22348d'
      AND (SELECT md5(pg_get_functiondef('public.am_plan_arrears(uuid[],date)'::regprocedure))) = '4163ea4e78cbab5e9717c4147e217cab'
      AND (SELECT md5(pg_get_functiondef('public.am_plan_clock(uuid[])'::regprocedure))) = '92052ae9482030c00983e7bfda9d5f4b'
      AND (SELECT md5(pg_get_functiondef('public.am_plan_positions(date,date,boolean)'::regprocedure))) = '98ca49701f2ffdcc388e4fa90c351d5d'
      AND (SELECT md5(pg_get_functiondef('public.get_tenant_ops_weekly_performance_amclock(date)'::regprocedure))) = '488cd37a7665c5ac07c09a0876c6275d'
      AND (SELECT md5(pg_get_functiondef('public.get_tenant_ops_weekly_history_amclock(integer)'::regprocedure))) = '63204faae22a7af129c861aa8cee6f7b'
      AND (SELECT bool_and(provolatile = 's') FROM pg_proc WHERE pronamespace = 'public'::regnamespace
            AND proname IN ('get_tenant_ops_no_payment_report_v2', 'get_tenant_ops_dormant_amclock', '_tenant_ops_dormant_days_amclock')));

  RAISE EXCEPTION 'ROLLED BACK REPORT (block 2): %', jsonb_pretty(r);
END
$test$;

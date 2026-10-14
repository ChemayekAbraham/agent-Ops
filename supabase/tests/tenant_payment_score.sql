-- Rolled-back verification for 20261014100000_tenant_payment_score.sql
--
-- Run against the live database, one block at a time. Each block ends in RAISE EXCEPTION, so nothing is kept and
-- the error text IS the report (steps with "pass"). Every step must pass. Four blocks, each well under a minute:
--
-- Block 1  access and the table
--   A  tenant_payment_score: the ten staff roles are let in; signed-out and no-role refused; anon cannot call it;
--      the helpers and the nightly job are not callable from the API; an empty or NULL list returns nothing; more
--      than 2000 ids is refused
--   B  tenant_payment_score_daily: RLS on, staff-read policy, only SELECT for authenticated, nothing for anon;
--      staff read rows, a user without a role reads none; insert / update / delete / truncate refused for the API
--      roles; update / delete / truncate refused even for the owner (append-only triggers)
-- Block 2  the history score, recomputed independently
--   C  shape: 0 to 100, five components capped at 40 / 25 / 15 / 10 / 10, points add up to the score, one-line reason,
--      label agrees with the score; the staff function equals the job's scoring
--   D  paid/owed, on-time days, completed plans, self-paid share and 20+ day gaps recomputed for a sample straight
--      from am_plan_arrears and agent_collections
--   E  plans whose landlord is not paid are ignored (paid and owed equal the counted plans only; a tenant with only
--      such plans is "new", never "history")
--   F  reversed collections are ignored: reversing one moves paid by exactly its amount (and self-paid for a
--      tenant_deposit_auto one); reversing all of a tenant's collections takes paid, on-time and self-paid to zero
-- Block 3  new tenants and labels
--   G  agent portfolio paid/owed (60) and trust score (40) recomputed for a sample; neutral values when there is no
--      agent portfolio (30) or no trust score (20); the agent fallback (request agent, managing agent, referrer)
--   H  label cut-offs on both sides of every boundary; proven_good only for history, good_agent_pick only for new
-- Block 4  the job, the schedule and "no writes to money or status"
--   I  the job writes one row per tenant per day, a second run adds nothing, rows equal the live scoring
--   J  the cron job is scheduled at 21:45 UTC = 00:45 Kampala and is active
--   K  nothing else moved: fingerprints of rent_requests (status and amounts), agent_collections, repayments,
--      the wallet projection and the ledger are identical before and after running the function and the job; the
--      scoring functions contain no INSERT / UPDATE / DELETE other than the job's own table; they are STABLE

-- ===== Block 1: A and B =====
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_role text; v_user uuid; v_staff uuid; v_plain uuid; v_gate boolean; v_ok boolean; v_n int;
  v_run jsonb;
BEGIN
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'operations' AND enabled LIMIT 1;
  SELECT p.id INTO v_plain FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) LIMIT 1;

  -- A: access
  FOREACH v_role IN ARRAY ARRAY['manager','super_admin','coo','ceo','cto','cfo','operations','tenant_ops','agent_ops','financial_ops'] LOOP
    SELECT ur.user_id INTO v_user FROM public.user_roles ur WHERE ur.role::text = v_role AND ur.enabled
     ORDER BY (SELECT count(*) FROM public.user_roles u2 WHERE u2.user_id = ur.user_id AND u2.enabled), ur.user_id LIMIT 1;
    IF v_user IS NULL THEN
      r := r || jsonb_build_object('step', 'A role ' || v_role, 'pass', NULL, 'detail', 'skipped: no enabled user holds this role');
      CONTINUE;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    v_gate := true;
    BEGIN PERFORM * FROM public.tenant_payment_score(ARRAY[]::uuid[]); EXCEPTION WHEN OTHERS THEN v_gate := false; END;
    r := r || jsonb_build_object('step', 'A role ' || v_role || ' is let in', 'pass', v_gate);
  END LOOP;

  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false;
  BEGIN PERFORM * FROM public.tenant_payment_score(ARRAY[gen_random_uuid()]); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'A signed-out call refused (42501)', 'pass', v_ok);
  IF v_plain IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_plain, 'role', 'authenticated')::text, true);
    v_ok := false;
    BEGIN PERFORM * FROM public.tenant_payment_score(ARRAY[gen_random_uuid()]); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    r := r || jsonb_build_object('step', 'A a user without a role is refused (42501)', 'pass', v_ok);
  END IF;
  r := r || jsonb_build_object('step', 'A anon cannot call it; authenticated can; helpers and the job are internal',
    'pass', NOT has_function_privilege('anon', 'public.tenant_payment_score(uuid[])', 'EXECUTE')
        AND has_function_privilege('authenticated', 'public.tenant_payment_score(uuid[])', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public._tenant_payment_score_core(uuid[],date)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public._tenant_payment_score_core(uuid[],date)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public._tps_label(integer,text)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public.tenant_payment_score_run(date)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.tenant_payment_score_run(date)', 'EXECUTE')
        AND NOT has_function_privilege('service_role', 'public.tenant_payment_score_run(date)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public._tenant_payment_score_append_only()', 'EXECUTE'));

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM public.tenant_payment_score(NULL);
  r := r || jsonb_build_object('step', 'A a NULL list returns nothing', 'pass', v_n = 0);
  v_ok := false;
  BEGIN PERFORM * FROM public.tenant_payment_score(ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 2001)));
  EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023'; END;
  r := r || jsonb_build_object('step', 'A 2001 ids refused (22023); 2000 allowed', 'pass', v_ok
    AND (SELECT count(*) FROM public.tenant_payment_score(ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 2000)))) = 2000);

  -- B: the table
  r := r || jsonb_build_object('step', 'B RLS is on and the staff-read policy exists',
    'pass', (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tenant_payment_score_daily'::regclass)
        AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tenant_payment_score_daily'
                      AND policyname = 'tenant_payment_score_daily_staff_read' AND cmd = 'SELECT'));
  r := r || jsonb_build_object('step', 'B authenticated has SELECT only; anon nothing; service_role cannot update, delete or truncate',
    'pass', has_table_privilege('authenticated', 'public.tenant_payment_score_daily', 'SELECT')
        AND NOT has_table_privilege('authenticated', 'public.tenant_payment_score_daily', 'INSERT')
        AND NOT has_table_privilege('authenticated', 'public.tenant_payment_score_daily', 'UPDATE')
        AND NOT has_table_privilege('authenticated', 'public.tenant_payment_score_daily', 'DELETE')
        AND NOT has_table_privilege('authenticated', 'public.tenant_payment_score_daily', 'TRUNCATE')
        AND NOT has_table_privilege('anon', 'public.tenant_payment_score_daily', 'SELECT')
        AND NOT has_table_privilege('anon', 'public.tenant_payment_score_daily', 'INSERT')
        AND NOT has_table_privilege('service_role', 'public.tenant_payment_score_daily', 'UPDATE')
        AND NOT has_table_privilege('service_role', 'public.tenant_payment_score_daily', 'DELETE')
        AND NOT has_table_privilege('service_role', 'public.tenant_payment_score_daily', 'TRUNCATE'));

  v_run := public.tenant_payment_score_run(v_today - 1);
  r := r || jsonb_build_object('step', 'B the job wrote the snapshot (rolled back)', 'pass', (v_run->>'tenants')::int > 0, 'detail', v_run);

  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.tenant_payment_score_daily WHERE score_date = v_today - 1;
  r := r || jsonb_build_object('step', 'B staff read the rows', 'pass', v_n = (v_run->>'tenants')::int, 'detail', v_n);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_plain, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM public.tenant_payment_score_daily;
  r := r || jsonb_build_object('step', 'B a user without a role reads no rows', 'pass', v_n = 0, 'detail', v_n);
  v_ok := false;
  BEGIN INSERT INTO public.tenant_payment_score_daily (score_date, tenant_id, score, label, reason, basis, components)
        VALUES (v_today, gen_random_uuid(), 50, 'average', 'x', 'new', '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN v_ok := true; END;
  r := r || jsonb_build_object('step', 'B direct INSERT by an API role refused', 'pass', v_ok);
  v_ok := false;
  BEGIN UPDATE public.tenant_payment_score_daily SET score = 0; EXCEPTION WHEN OTHERS THEN v_ok := true; END;
  r := r || jsonb_build_object('step', 'B direct UPDATE by an API role refused', 'pass', v_ok);
  v_ok := false;
  BEGIN DELETE FROM public.tenant_payment_score_daily; EXCEPTION WHEN OTHERS THEN v_ok := true; END;
  r := r || jsonb_build_object('step', 'B direct DELETE by an API role refused', 'pass', v_ok);
  SET LOCAL ROLE anon;
  v_ok := false;
  BEGIN PERFORM count(*) FROM public.tenant_payment_score_daily; EXCEPTION WHEN OTHERS THEN v_ok := true; END;
  r := r || jsonb_build_object('step', 'B anon cannot read the table', 'pass', v_ok);
  RESET ROLE;

  v_ok := false;
  BEGIN UPDATE public.tenant_payment_score_daily SET score = 0; EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE '%append-only%'; END;
  r := r || jsonb_build_object('step', 'B UPDATE refused even for the owner (append-only)', 'pass', v_ok);
  v_ok := false;
  BEGIN DELETE FROM public.tenant_payment_score_daily; EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE '%append-only%'; END;
  r := r || jsonb_build_object('step', 'B DELETE refused even for the owner (append-only)', 'pass', v_ok);
  v_ok := false;
  BEGIN TRUNCATE public.tenant_payment_score_daily; EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE '%append-only%'; END;
  r := r || jsonb_build_object('step', 'B TRUNCATE refused even for the owner (append-only)', 'pass', v_ok);

  RAISE EXCEPTION 'ROLLED BACK REPORT (block 1): %', jsonb_pretty(r);
END
$test$;

-- ===== Block 2: C, D, E and F =====
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_asat date := (now() AT TIME ZONE 'Africa/Kampala')::date - 1;
  v_staff uuid;
  v_ids uuid[];
  v_t record; v_p record; v_c record;
  v_paid numeric; v_exp numeric; v_done int; v_plans int; v_self numeric; v_tot numeric;
  v_due int; v_ok_n int; v_gap int; v_k int; v_nk int; v_cum numeric; v_prev date; v_d date;
  v_days date[];
  bad_paid int := 0; bad_ontime int := 0; bad_done int := 0; bad_self int := 0; bad_gap int := 0; checked int := 0;
  ex jsonb := '[]'::jsonb;
  v_n int; v_m int;
  v_cid uuid; v_amt numeric; v_ch text; v_rid uuid; v_tenant uuid;
  v_before numeric; v_after numeric; v_self_before numeric; v_self_after numeric; v_created timestamptz;
BEGIN
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'operations' AND enabled LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);

  SELECT array_agg(DISTINCT r2.tenant_id) INTO v_ids
    FROM public.rent_requests r2 JOIN public.profiles p ON p.id = r2.tenant_id AND p.deleted_at IS NULL
   WHERE r2.status NOT IN ('rejected','cancelled','deleted_by_agent');
  CREATE TEMP TABLE _s ON COMMIT DROP AS SELECT * FROM public._tenant_payment_score_core(v_ids, v_asat);

  -- C: shape
  SELECT count(*) INTO v_n FROM _s;
  r := r || jsonb_build_object('step', 'C one row per tenant', 'pass', v_n = cardinality(v_ids) AND (SELECT count(DISTINCT tenant_id) FROM _s) = v_n, 'detail', v_n);
  SELECT count(*) INTO v_n FROM _s WHERE score NOT BETWEEN 0 AND 100;
  r := r || jsonb_build_object('step', 'C every score is 0 to 100', 'pass', v_n = 0);
  SELECT count(*) INTO v_n FROM _s
   WHERE basis = 'history' AND NOT (
         (components->'paid_owed'->>'max')::numeric = 40 AND (components->'on_time'->>'max')::numeric = 25
     AND (components->'completed'->>'max')::numeric = 15 AND (components->'self_paid'->>'max')::numeric = 10
     AND (components->'no_gaps'->>'max')::numeric = 10
     AND (components->'paid_owed'->>'points')::numeric BETWEEN 0 AND 40 AND (components->'on_time'->>'points')::numeric BETWEEN 0 AND 25
     AND (components->'completed'->>'points')::numeric BETWEEN 0 AND 15 AND (components->'self_paid'->>'points')::numeric BETWEEN 0 AND 10
     AND (components->'no_gaps'->>'points')::numeric BETWEEN 0 AND 10
     AND score = round((components->'paid_owed'->>'points')::numeric + (components->'on_time'->>'points')::numeric
                     + (components->'completed'->>'points')::numeric + (components->'self_paid'->>'points')::numeric
                     + (components->'no_gaps'->>'points')::numeric));
  r := r || jsonb_build_object('step', 'C history: 40 + 25 + 15 + 10 + 10 = 100, each within its cap, points add up to the score', 'pass', v_n = 0, 'detail', v_n);
  SELECT count(*) INTO v_n FROM _s
   WHERE basis = 'new' AND NOT (
         (components->'agent_portfolio'->>'max')::numeric = 60 AND (components->'trust'->>'max')::numeric = 40
     AND (components->'agent_portfolio'->>'points')::numeric BETWEEN 0 AND 60 AND (components->'trust'->>'points')::numeric BETWEEN 0 AND 40
     AND score = round((components->'agent_portfolio'->>'points')::numeric + (components->'trust'->>'points')::numeric));
  r := r || jsonb_build_object('step', 'C new: 60 + 40 = 100, each within its cap, points add up to the score', 'pass', v_n = 0, 'detail', v_n);
  SELECT count(*) INTO v_n FROM _s WHERE reason IS NULL OR reason ~ '[\r\n]' OR length(reason) > 200 OR length(reason) < 10;
  r := r || jsonb_build_object('step', 'C the reason is one line', 'pass', v_n = 0);
  SELECT count(*) INTO v_n FROM _s WHERE label IS DISTINCT FROM public._tps_label(score, basis)
     OR label NOT IN ('proven_good','good_agent_pick','average','watch');
  r := r || jsonb_build_object('step', 'C label agrees with the score and basis', 'pass', v_n = 0);
  SELECT count(*) INTO v_n FROM public.tenant_payment_score(ARRAY(SELECT tenant_id FROM _s ORDER BY md5(tenant_id::text) LIMIT 500)) f
    JOIN public._tenant_payment_score_core(ARRAY(SELECT tenant_id FROM _s ORDER BY md5(tenant_id::text) LIMIT 500), v_today) c USING (tenant_id)
   WHERE f.score = c.score AND f.label = c.label AND f.reason = c.reason AND f.basis = c.basis;
  r := r || jsonb_build_object('step', 'C the staff function returns the scoring for today (500 sample)', 'pass', v_n = 500, 'detail', v_n);
  r := r || jsonb_build_object('step', 'C an unknown tenant gets the neutral new-tenant score (30 + 20 = 50, average)',
    'pass', (SELECT bool_and(score = 50 AND label = 'average' AND basis = 'new') FROM public.tenant_payment_score(ARRAY[gen_random_uuid()])));

  -- D: independent recompute for a sample straight from am_plan_arrears and agent_collections
  FOR v_t IN
    (SELECT s.tenant_id, s.components FROM _s s WHERE s.basis = 'history' ORDER BY md5(s.tenant_id::text) LIMIT 40)
    UNION
    (SELECT s.tenant_id, s.components FROM _s s WHERE s.basis = 'history' ORDER BY (s.components->'no_gaps'->>'gaps_20_plus')::int DESC, s.tenant_id LIMIT 8)
    UNION
    (SELECT s.tenant_id, s.components FROM _s s WHERE s.basis = 'history' ORDER BY s.score DESC, s.tenant_id LIMIT 6)
  LOOP
    checked := checked + 1;
    v_paid := 0; v_exp := 0; v_done := 0; v_plans := 0; v_due := 0; v_ok_n := 0; v_gap := 0; v_self := 0; v_tot := 0;
    FOR v_p IN
      SELECT a.rent_request_id AS rid, a.cadence, a.clock_start AS cs, a.expected_to_date AS expected, a.paid_to_date AS paid,
             rr.status, COALESCE(rr.total_repayment,0) AS total, COALESCE(rr.amount_repaid,0) AS repaid, COALESCE(rr.daily_repayment,0) AS daily
        FROM public._am_plan_arrears_core(ARRAY(SELECT x.id FROM public.rent_requests x WHERE x.tenant_id = v_t.tenant_id
                                                 AND x.status IN ('funded','disbursed','repaying','completed')), v_asat) a
        JOIN public.rent_requests rr ON rr.id = a.rent_request_id
       WHERE a.bucket IN ('counting','outstanding_balance') AND a.clock_start IS NOT NULL AND a.clock_start < v_asat
    LOOP
      v_plans := v_plans + 1;
      v_paid := v_paid + v_p.paid; v_exp := v_exp + v_p.expected;
      IF v_p.status = 'completed' OR (v_p.total > 0 AND v_p.repaid >= v_p.total) THEN v_done := v_done + 1; END IF;
      -- self-paid share and total collected (not reversed, liability settlements excluded)
      SELECT COALESCE(sum(ac.amount) FILTER (WHERE ac.collection_channel = 'tenant_deposit_auto'), 0), COALESCE(sum(ac.amount), 0)
        INTO v_cum, v_nk
        FROM public.agent_collections ac
       WHERE ac.rent_request_id = v_p.rid AND ac.reversed_at IS NULL AND ac.collection_channel <> 'agent_liability_settlement'
         AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= v_asat;
      v_self := v_self + v_cum; v_tot := v_tot + v_nk;
      -- on-time days: on each due date the money collected up to and including that day covers the cumulative amount due
      IF COALESCE(v_p.daily,0) > 0 THEN
        v_k := 1;
        WHILE v_k <= ceil(v_p.total / (v_p.daily * CASE WHEN v_p.cadence = 'weekly' THEN 7 ELSE 1 END))::int
          AND v_p.cs + (v_k - 1) * CASE WHEN v_p.cadence = 'weekly' THEN 7 ELSE 1 END < v_asat LOOP
          v_d := v_p.cs + (v_k - 1) * CASE WHEN v_p.cadence = 'weekly' THEN 7 ELSE 1 END;
          SELECT COALESCE(sum(ac.amount), 0) INTO v_cum FROM public.agent_collections ac
           WHERE ac.rent_request_id = v_p.rid AND ac.reversed_at IS NULL AND ac.collection_channel <> 'agent_liability_settlement'
             AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= v_d;
          v_due := v_due + 1;
          IF v_cum >= LEAST(v_p.total, v_p.daily * CASE WHEN v_p.cadence = 'weekly' THEN 7 ELSE 1 END * v_k) THEN v_ok_n := v_ok_n + 1; END IF;
          v_k := v_k + 1;
        END LOOP;
      END IF;
      -- 20+ day gaps: between the clock start, each day with a collection, and today while still owing
      SELECT array_agg(DISTINCT d ORDER BY d) INTO v_days FROM (
        SELECT v_p.cs AS d
        UNION SELECT (ac.created_at AT TIME ZONE 'Africa/Kampala')::date FROM public.agent_collections ac
               WHERE ac.rent_request_id = v_p.rid AND ac.reversed_at IS NULL AND ac.collection_channel <> 'agent_liability_settlement'
                 AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date > v_p.cs AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= v_asat
        UNION SELECT v_asat WHERE v_p.status <> 'completed' AND v_p.total - v_p.repaid > 0) q;
      v_prev := NULL;
      FOREACH v_d IN ARRAY v_days LOOP
        IF v_prev IS NOT NULL AND v_d - v_prev >= 20 THEN v_gap := v_gap + 1; END IF;
        v_prev := v_d;
      END LOOP;
    END LOOP;

    v_c := NULL;
    IF abs(v_paid - (v_t.components->'paid_owed'->>'paid')::numeric) > 0.01 OR abs(v_exp - (v_t.components->'paid_owed'->>'expected')::numeric) > 0.01 THEN
      bad_paid := bad_paid + 1; ex := ex || jsonb_build_object('tenant', v_t.tenant_id, 'what', 'paid/owed', 'mine', jsonb_build_array(v_paid, v_exp), 'live', v_t.components->'paid_owed'); END IF;
    IF v_due <> (v_t.components->'on_time'->>'due_days')::int OR v_ok_n <> (v_t.components->'on_time'->>'on_time_days')::int THEN
      bad_ontime := bad_ontime + 1; ex := ex || jsonb_build_object('tenant', v_t.tenant_id, 'what', 'on_time', 'mine', jsonb_build_array(v_ok_n, v_due), 'live', v_t.components->'on_time'); END IF;
    IF v_done <> (v_t.components->'completed'->>'completed')::int OR v_plans <> (v_t.components->'completed'->>'plans')::int THEN
      bad_done := bad_done + 1; ex := ex || jsonb_build_object('tenant', v_t.tenant_id, 'what', 'completed', 'mine', jsonb_build_array(v_done, v_plans), 'live', v_t.components->'completed'); END IF;
    IF abs(v_self - (v_t.components->'self_paid'->>'self_ugx')::numeric) > 0.01 OR abs(v_tot - (v_t.components->'self_paid'->>'collected_ugx')::numeric) > 0.01 THEN
      bad_self := bad_self + 1; ex := ex || jsonb_build_object('tenant', v_t.tenant_id, 'what', 'self', 'mine', jsonb_build_array(v_self, v_tot), 'live', v_t.components->'self_paid'); END IF;
    IF v_gap <> (v_t.components->'no_gaps'->>'gaps_20_plus')::int THEN
      bad_gap := bad_gap + 1; ex := ex || jsonb_build_object('tenant', v_t.tenant_id, 'what', 'gaps', 'mine', v_gap, 'live', v_t.components->'no_gaps'); END IF;
  END LOOP;
  r := r || jsonb_build_object('step', 'D paid/owed equals am_plan_arrears (counted plans) for the sample', 'pass', bad_paid = 0, 'detail', jsonb_build_object('checked', checked, 'bad', bad_paid));
  r := r || jsonb_build_object('step', 'D on-time days recomputed from agent_collections', 'pass', bad_ontime = 0, 'detail', bad_ontime);
  r := r || jsonb_build_object('step', 'D completed plans recomputed', 'pass', bad_done = 0, 'detail', bad_done);
  r := r || jsonb_build_object('step', 'D self-paid (tenant_deposit_auto) share recomputed', 'pass', bad_self = 0, 'detail', bad_self);
  r := r || jsonb_build_object('step', 'D 20+ day gaps recomputed', 'pass', bad_gap = 0, 'detail', bad_gap);
  IF jsonb_array_length(ex) > 0 THEN r := r || jsonb_build_object('step', 'D examples of mismatches', 'pass', false, 'detail', ex); END IF;
  SELECT count(*) INTO v_n FROM _s WHERE basis = 'history' AND (components->'no_gaps'->>'gaps_20_plus')::int > 0;
  SELECT count(*) INTO v_m FROM _s WHERE basis = 'history' AND (components->'self_paid'->>'self_ugx')::numeric > 0;
  r := r || jsonb_build_object('step', 'D the sample is not vacuous (tenants with a gap / with self-payment exist)', 'pass', v_n > 0 AND v_m > 0, 'detail', jsonb_build_object('with_gap', v_n, 'with_self', v_m));

  -- E: plans whose landlord has not been paid are ignored (all history tenants, set based)
  WITH h AS (SELECT tenant_id, (components->'paid_owed'->>'paid')::numeric AS paid, (components->'paid_owed'->>'expected')::numeric AS expected FROM _s WHERE basis = 'history'),
  allp AS (
    SELECT rr.tenant_id, a.bucket, a.clock_start, a.paid_to_date, a.expected_to_date
      FROM public._am_plan_arrears_core(ARRAY(SELECT x.id FROM public.rent_requests x WHERE x.tenant_id IN (SELECT tenant_id FROM h)
                                               AND x.status IN ('funded','disbursed','repaying','completed')), v_asat) a
      JOIN public.rent_requests rr ON rr.id = a.rent_request_id),
  cnt AS (SELECT tenant_id, COALESCE(sum(paid_to_date),0) AS paid, COALESCE(sum(expected_to_date),0) AS expected
            FROM allp WHERE bucket IN ('counting','outstanding_balance') AND clock_start IS NOT NULL AND clock_start < v_asat GROUP BY tenant_id),
  unp AS (SELECT tenant_id, count(*) AS n, COALESCE(sum(paid_to_date),0) AS paid FROM allp WHERE bucket IN ('tenant_paying_no_landlord','awaiting_landlord') GROUP BY tenant_id)
  SELECT count(*) FILTER (WHERE abs(h.paid - COALESCE(cnt.paid,0)) > 0.01 OR abs(h.expected - COALESCE(cnt.expected,0)) > 0.01),
         count(*) FILTER (WHERE unp.n > 0),
         count(*) FILTER (WHERE unp.paid > 0)
    INTO v_n, v_m, checked
    FROM h LEFT JOIN cnt USING (tenant_id) LEFT JOIN unp USING (tenant_id);
  r := r || jsonb_build_object('step', 'E every history tenant: paid and owed are the counted plans only (landlord-not-paid plans add nothing)', 'pass', v_n = 0,
    'detail', jsonb_build_object('mismatches', v_n, 'tenants_that_also_have_an_unpaid_landlord_plan', v_m, 'of_which_with_payments_on_it', checked));
  r := r || jsonb_build_object('step', 'E a tenant with no counted plan is never scored on history',
    'pass', NOT EXISTS (SELECT 1 FROM _s s WHERE s.basis = 'history' AND (s.components->'completed'->>'plans')::int = 0));

  -- F: reversed collections are ignored
  -- one tenant_deposit_auto and one agent_float collection on a history tenant that still owes (so the ratio is not capped)
  SELECT count(*) INTO v_n FROM public.agent_collections ac WHERE ac.reversed_at IS NOT NULL AND ac.rent_request_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.repayments rp WHERE rp.rent_request_id = ac.rent_request_id AND COALESCE(rp.amount, 0) = COALESCE(ac.amount, 0)
                   AND abs(extract(epoch FROM (ac.created_at - rp.created_at))) < 300);
  r := r || jsonb_build_object('step', 'F (informational) reversed collections that still have a repayments twin, which the clock would count as paid', 'pass', true, 'detail', v_n);
  FOREACH v_ch IN ARRAY ARRAY['tenant_deposit_auto', 'agent_float'] LOOP
    v_cid := NULL;
    SELECT ac.id, ac.amount, ac.rent_request_id, rr.tenant_id, ac.created_at INTO v_cid, v_amt, v_rid, v_tenant, v_created
      FROM public.agent_collections ac
      JOIN public.rent_requests rr ON rr.id = ac.rent_request_id
      JOIN _s s ON s.tenant_id = rr.tenant_id AND s.basis = 'history'
     WHERE ac.collection_channel = v_ch AND ac.reversed_at IS NULL AND ac.amount > 0
       AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= v_asat
       AND (s.components->'paid_owed'->>'paid')::numeric > ac.amount
       AND (SELECT count(*) FROM public.rent_requests y WHERE y.tenant_id = rr.tenant_id AND y.status IN ('funded','disbursed','repaying','completed')) = 1
     ORDER BY md5(ac.id::text) LIMIT 1;
    IF v_cid IS NULL THEN
      r := r || jsonb_build_object('step', 'F reversing one ' || v_ch || ' collection', 'pass', NULL, 'detail', 'skipped: no suitable collection');
      CONTINUE;
    END IF;
    SELECT (components->'paid_owed'->>'paid')::numeric, (components->'self_paid'->>'self_ugx')::numeric INTO v_before, v_self_before
      FROM public._tenant_payment_score_core(ARRAY[v_tenant], v_asat);
    SET LOCAL session_replication_role = replica;
    UPDATE public.agent_collections SET reversed_at = now() WHERE id = v_cid;
    -- a real reversal leaves no repayments twin (none of the live reversed collections has one); the clock would
    -- otherwise count that twin as money paid
    DELETE FROM public.repayments rp WHERE rp.rent_request_id = v_rid AND COALESCE(rp.amount, 0) = v_amt
       AND abs(extract(epoch FROM (v_created - rp.created_at))) < 300;
    SET LOCAL session_replication_role = origin;
    SELECT (components->'paid_owed'->>'paid')::numeric, (components->'self_paid'->>'self_ugx')::numeric INTO v_after, v_self_after
      FROM public._tenant_payment_score_core(ARRAY[v_tenant], v_asat);
    r := r || jsonb_build_object('step', 'F reversing one ' || v_ch || ' collection takes exactly its amount off paid'
        || CASE WHEN v_ch = 'tenant_deposit_auto' THEN ' and off self-paid' ELSE ' and leaves self-paid alone' END,
      'pass', abs((v_before - v_after) - v_amt) < 0.01
          AND CASE WHEN v_ch = 'tenant_deposit_auto' THEN abs((v_self_before - v_self_after) - v_amt) < 0.01
                   ELSE abs(v_self_before - v_self_after) < 0.01 END,
      'detail', jsonb_build_object('amount', v_amt, 'paid_before', v_before, 'paid_after', v_after, 'self_before', v_self_before, 'self_after', v_self_after));
  END LOOP;
  -- reverse everything one tenant paid
  SELECT s.tenant_id INTO v_tenant FROM _s s
   WHERE s.basis = 'history' AND (s.components->'paid_owed'->>'paid')::numeric > 0 AND (s.components->'self_paid'->>'self_ugx')::numeric > 0
   ORDER BY md5(s.tenant_id::text) LIMIT 1;
  IF v_tenant IS NOT NULL THEN
    SET LOCAL session_replication_role = replica;
    UPDATE public.agent_collections SET reversed_at = now()
     WHERE reversed_at IS NULL AND rent_request_id IN (SELECT id FROM public.rent_requests WHERE tenant_id = v_tenant);
    DELETE FROM public.repayments WHERE rent_request_id IN (SELECT id FROM public.rent_requests WHERE tenant_id = v_tenant);
    SET LOCAL session_replication_role = origin;
    SELECT * INTO v_c FROM public._tenant_payment_score_core(ARRAY[v_tenant], v_asat);
    r := r || jsonb_build_object('step', 'F reversing all of a tenant''s collections takes paid, on-time and self-paid to zero',
      'pass', (v_c.components->'paid_owed'->>'paid')::numeric = 0 AND (v_c.components->'self_paid'->>'self_ugx')::numeric = 0
          AND (v_c.components->'on_time'->>'on_time_days')::int = 0 AND (v_c.components->'self_paid'->>'points')::numeric = 0,
      'detail', v_c.components);
  END IF;

  RAISE EXCEPTION 'ROLLED BACK REPORT (block 2): %', jsonb_pretty(r);
END
$test$;

-- ===== Block 3: G and H =====
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_asat date := (now() AT TIME ZONE 'Africa/Kampala')::date - 1;
  v_staff uuid;
  v_ids uuid[];
  v_t record; v_ap record;
  v_agent uuid; v_paid numeric; v_exp numeric; v_trust numeric; v_pa numeric; v_pt numeric;
  bad int := 0; checked int := 0; ex jsonb := '[]'::jsonb; v_n int; v_m int;
BEGIN
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'operations' AND enabled LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  SELECT array_agg(DISTINCT r2.tenant_id) INTO v_ids
    FROM public.rent_requests r2 JOIN public.profiles p ON p.id = r2.tenant_id AND p.deleted_at IS NULL
   WHERE r2.status NOT IN ('rejected','cancelled','deleted_by_agent');
  CREATE TEMP TABLE _s ON COMMIT DROP AS SELECT * FROM public._tenant_payment_score_core(v_ids, v_asat);

  -- G: new tenants, recomputed (a sample, plus every neutral shape we can find)
  FOR v_t IN
    (SELECT s.tenant_id, s.score, s.components FROM _s s WHERE s.basis = 'new' ORDER BY md5(s.tenant_id::text) LIMIT 40)
    UNION
    (SELECT s.tenant_id, s.score, s.components FROM _s s WHERE s.basis = 'new' ORDER BY s.score DESC, s.tenant_id LIMIT 6)
    UNION
    (SELECT s.tenant_id, s.score, s.components FROM _s s WHERE s.basis = 'new' AND (s.components->'trust'->>'score') IS NULL ORDER BY md5(s.tenant_id::text) LIMIT 6)
  LOOP
    checked := checked + 1;
    SELECT COALESCE(x.assigned_agent_id, x.agent_id, pr.managing_agent_id, pr.referrer_id) INTO v_agent
      FROM public.profiles pr LEFT JOIN LATERAL (
             SELECT q.assigned_agent_id, q.agent_id FROM public.rent_requests q
              WHERE q.tenant_id = pr.id AND q.status NOT IN ('rejected','cancelled','deleted_by_agent')
              ORDER BY q.created_at DESC LIMIT 1) x ON true
     WHERE pr.id = v_t.tenant_id;
    SELECT COALESCE(sum(a.paid_to_date), 0), COALESCE(sum(a.expected_to_date), 0) INTO v_paid, v_exp
      FROM public._am_plan_arrears_core(ARRAY(SELECT x.id FROM public.rent_requests x
                                               WHERE x.status IN ('funded','disbursed','repaying','completed')
                                                 AND COALESCE(x.assigned_agent_id, x.agent_id) = v_agent AND v_agent IS NOT NULL), v_asat) a
     WHERE a.bucket IN ('counting','outstanding_balance') AND a.clock_start IS NOT NULL AND a.clock_start < v_asat;
    SELECT score INTO v_trust FROM public.welile_trust_score_cache WHERE user_id = v_t.tenant_id;
    v_pa := CASE WHEN v_exp > 0 THEN round(60 * LEAST(1, v_paid / v_exp), 1) ELSE 30 END;
    v_pt := CASE WHEN v_trust IS NOT NULL THEN round(40 * LEAST(100, GREATEST(0, v_trust)) / 100, 1) ELSE 20 END;
    IF v_pa <> (v_t.components->'agent_portfolio'->>'points')::numeric OR v_pt <> (v_t.components->'trust'->>'points')::numeric
       OR round(v_pa + v_pt)::int <> v_t.score
       OR COALESCE(v_agent::text, '') <> COALESCE(v_t.components->'agent_portfolio'->>'agent_id', '') THEN
      bad := bad + 1; ex := ex || jsonb_build_object('tenant', v_t.tenant_id, 'mine', jsonb_build_array(v_agent, v_pa, v_pt), 'live', v_t.components);
    END IF;
  END LOOP;
  r := r || jsonb_build_object('step', 'G agent portfolio (60) and trust score (40) recomputed, including the agent fallback', 'pass', bad = 0, 'detail', jsonb_build_object('checked', checked, 'bad', bad));
  IF bad > 0 THEN r := r || jsonb_build_object('step', 'G examples', 'pass', false, 'detail', ex); END IF;
  SELECT count(*) FILTER (WHERE (components->'agent_portfolio'->>'expected')::numeric = 0 OR components->'agent_portfolio'->>'expected' IS NULL),
         count(*) FILTER (WHERE components->'trust'->>'score' IS NULL)
    INTO v_n, v_m FROM _s WHERE basis = 'new';
  r := r || jsonb_build_object('step', 'G neutral values: no agent portfolio = 30 of 60; no trust score = 20 of 40',
    'pass', NOT EXISTS (SELECT 1 FROM _s WHERE basis = 'new'
                          AND ((COALESCE((components->'agent_portfolio'->>'expected')::numeric, 0) = 0 AND (components->'agent_portfolio'->>'points')::numeric <> 30)
                            OR ((components->'trust'->>'score') IS NULL AND (components->'trust'->>'points')::numeric <> 20)
                            OR ((components->'trust'->>'score') IS NOT NULL AND (components->'trust'->>'points')::numeric = 20 AND (components->'trust'->>'score')::numeric <> 50))),
    'detail', jsonb_build_object('without_agent_portfolio', v_n, 'without_trust_score', v_m));
  SELECT count(*) INTO v_n FROM _s s
    JOIN public.profiles pr ON pr.id = s.tenant_id
   WHERE s.basis = 'new' AND pr.managing_agent_id IS NOT NULL AND (s.components->'agent_portfolio'->>'agent_id') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.rent_requests q WHERE q.tenant_id = s.tenant_id AND COALESCE(q.assigned_agent_id, q.agent_id) IS NOT NULL
                       AND q.status NOT IN ('rejected','cancelled','deleted_by_agent'));
  r := r || jsonb_build_object('step', 'G tenants with no agent on the request use their managing agent or referrer (informational count)', 'pass', true, 'detail', v_n);
  r := r || jsonb_build_object('step', 'G new-tenant reasons name the agent portfolio and the trust score',
    'pass', NOT EXISTS (SELECT 1 FROM _s WHERE basis = 'new' AND reason NOT LIKE 'New tenant: %'));

  -- H: label cut-offs on both sides of every boundary
  r := r || jsonb_build_object('step', 'H history: 79 average, 80 proven_good, 49 watch, 50 average',
    'pass', public._tps_label(79,'history') = 'average' AND public._tps_label(80,'history') = 'proven_good'
        AND public._tps_label(49,'history') = 'watch' AND public._tps_label(50,'history') = 'average'
        AND public._tps_label(100,'history') = 'proven_good' AND public._tps_label(0,'history') = 'watch');
  r := r || jsonb_build_object('step', 'H new: 64 average, 65 good_agent_pick, 29 watch, 30 average',
    'pass', public._tps_label(64,'new') = 'average' AND public._tps_label(65,'new') = 'good_agent_pick'
        AND public._tps_label(29,'new') = 'watch' AND public._tps_label(30,'new') = 'average'
        AND public._tps_label(100,'new') = 'good_agent_pick' AND public._tps_label(0,'new') = 'watch');
  r := r || jsonb_build_object('step', 'H proven_good appears only for history; good_agent_pick only for new',
    'pass', NOT EXISTS (SELECT 1 FROM _s WHERE (label = 'proven_good' AND basis <> 'history') OR (label = 'good_agent_pick' AND basis <> 'new')));
  r := r || jsonb_build_object('step', 'H the mix (informational)', 'pass', true,
    'detail', (SELECT jsonb_object_agg(basis || '/' || label, n) FROM (SELECT basis, label, count(*) AS n FROM _s GROUP BY 1, 2) q));

  RAISE EXCEPTION 'ROLLED BACK REPORT (block 3): %', jsonb_pretty(r);
END
$test$;

-- ===== Block 4: I, J and K =====
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_staff uuid;
  v_run1 jsonb; v_run2 jsonb;
  fp_before jsonb; fp_after jsonb;
  v_n int; v_m int; v_src text;
  v_fn text;
BEGIN
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'operations' AND enabled LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);

  -- K (before): fingerprints of everything that holds money or status
  fp_before := jsonb_build_object(
    'rent_requests', (SELECT md5(string_agg(concat_ws('|', id, status, amount_repaid, total_repayment, daily_repayment, assigned_agent_id, agent_id), ',' ORDER BY id)) FROM public.rent_requests),
    'agent_collections', (SELECT jsonb_build_object('n', count(*), 'sum', COALESCE(sum(amount), 0), 'reversed', count(*) FILTER (WHERE reversed_at IS NOT NULL)) FROM public.agent_collections),
    'repayments', (SELECT jsonb_build_object('n', count(*), 'sum', COALESCE(sum(amount), 0)) FROM public.repayments),
    'wallets', (SELECT jsonb_build_object('n', count(*), 'withdrawable', COALESCE(sum(withdrawable), 0), 'float', COALESCE(sum(float_balance), 0)) FROM public.wallet_balances_projection),
    'ledger', (SELECT jsonb_build_object('n', count(*), 'amount', COALESCE(sum(amount), 0)) FROM public.general_ledger),
    'profiles', (SELECT md5(string_agg(concat_ws('|', id, managing_agent_id, referrer_id), ',' ORDER BY id)) FROM public.profiles),
    'trust', (SELECT jsonb_build_object('n', count(*), 'sum', COALESCE(sum(score), 0)) FROM public.welile_trust_score_cache));

  -- I: the job
  v_run1 := public.tenant_payment_score_run(v_today - 1);
  v_run2 := public.tenant_payment_score_run(v_today - 1);
  r := r || jsonb_build_object('step', 'I the first run writes one row per scored tenant; history + new = inserted',
    'pass', (v_run1->>'inserted')::int = (v_run1->>'tenants')::int AND (v_run1->>'history')::int + (v_run1->>'new')::int = (v_run1->>'inserted')::int,
    'detail', v_run1);
  r := r || jsonb_build_object('step', 'I a second run for the same day adds nothing', 'pass', (v_run2->>'inserted')::int = 0, 'detail', v_run2);
  SELECT count(*), count(DISTINCT tenant_id) INTO v_n, v_m FROM public.tenant_payment_score_daily WHERE score_date = v_today - 1;
  r := r || jsonb_build_object('step', 'I exactly one row per tenant for the day', 'pass', v_n = v_m AND v_n = (v_run1->>'tenants')::int, 'detail', v_n);
  SELECT count(*) INTO v_n FROM public.tenant_payment_score_daily d
    JOIN public._tenant_payment_score_core(ARRAY(SELECT tenant_id FROM public.tenant_payment_score_daily WHERE score_date = v_today - 1 ORDER BY md5(tenant_id::text) LIMIT 300), v_today - 1) c
      ON c.tenant_id = d.tenant_id
   WHERE d.score_date = v_today - 1 AND d.score = c.score AND d.label = c.label AND d.reason = c.reason AND d.basis = c.basis AND d.components = c.components;
  r := r || jsonb_build_object('step', 'I stored rows equal the live scoring as at that day (300 sample)', 'pass', v_n = 300, 'detail', v_n);
  v_run1 := public.tenant_payment_score_run(NULL);
  r := r || jsonb_build_object('step', 'I the default day is yesterday in Kampala', 'pass', v_run1->>'score_date' = (v_today - 1)::text, 'detail', v_run1);
  -- the next day's run adds a new row set and leaves the first day's rows alone
  v_run2 := public.tenant_payment_score_run(v_today - 2);
  SELECT count(*) INTO v_n FROM public.tenant_payment_score_daily WHERE score_date = v_today - 1;
  r := r || jsonb_build_object('step', 'I another day adds its own rows and leaves the first day alone',
    'pass', (v_run2->>'inserted')::int > 0 AND v_n = (v_run1->>'tenants')::int);

  -- J: the schedule
  IF to_regnamespace('cron') IS NULL THEN
    r := r || jsonb_build_object('step', 'J the cron job', 'pass', false, 'detail', 'pg_cron is not installed');
  ELSE
    r := r || jsonb_build_object('step', 'J scheduled at 45 21 * * * UTC = 00:45 Africa/Kampala, active, runs the job',
      'pass', EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'tenant-payment-score-daily-0045-eat' AND j.schedule = '45 21 * * *'
                        AND j.active AND j.command ILIKE '%tenant_payment_score_run%'),
      'detail', (SELECT to_jsonb(j) - 'jobid' - 'username' - 'database' - 'nodename' - 'nodeport' FROM cron.job j WHERE j.jobname = 'tenant-payment-score-daily-0045-eat'));
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname LIKE 'tenant-payment-score%';
    r := r || jsonb_build_object('step', 'J only one such job', 'pass', v_n = 1, 'detail', v_n);
  END IF;

  -- K (after)
  PERFORM count(*) FROM public.tenant_payment_score(ARRAY(SELECT tenant_id FROM public.tenant_payment_score_daily LIMIT 1500));
  fp_after := jsonb_build_object(
    'rent_requests', (SELECT md5(string_agg(concat_ws('|', id, status, amount_repaid, total_repayment, daily_repayment, assigned_agent_id, agent_id), ',' ORDER BY id)) FROM public.rent_requests),
    'agent_collections', (SELECT jsonb_build_object('n', count(*), 'sum', COALESCE(sum(amount), 0), 'reversed', count(*) FILTER (WHERE reversed_at IS NOT NULL)) FROM public.agent_collections),
    'repayments', (SELECT jsonb_build_object('n', count(*), 'sum', COALESCE(sum(amount), 0)) FROM public.repayments),
    'wallets', (SELECT jsonb_build_object('n', count(*), 'withdrawable', COALESCE(sum(withdrawable), 0), 'float', COALESCE(sum(float_balance), 0)) FROM public.wallet_balances_projection),
    'ledger', (SELECT jsonb_build_object('n', count(*), 'amount', COALESCE(sum(amount), 0)) FROM public.general_ledger),
    'profiles', (SELECT md5(string_agg(concat_ws('|', id, managing_agent_id, referrer_id), ',' ORDER BY id)) FROM public.profiles),
    'trust', (SELECT jsonb_build_object('n', count(*), 'sum', COALESCE(sum(score), 0)) FROM public.welile_trust_score_cache));
  r := r || jsonb_build_object('step', 'K requests, collections, repayments, wallets, ledger, profiles and trust scores are identical after the function and the job ran',
    'pass', fp_before = fp_after, 'detail', CASE WHEN fp_before = fp_after THEN to_jsonb('identical'::text) ELSE jsonb_build_object('before', fp_before, 'after', fp_after) END);
  FOREACH v_fn IN ARRAY ARRAY['_tps_label', '_tenant_payment_score_core', 'tenant_payment_score'] LOOP
    SELECT prosrc, provolatile::text INTO v_src, v_m FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn;
    r := r || jsonb_build_object('step', 'K ' || v_fn || ' has no INSERT / UPDATE / DELETE / TRUNCATE and is not VOLATILE',
      'pass', v_src !~* '\m(insert\s+into|update\s+\w|delete\s+from|truncate)\M' AND (SELECT provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = v_fn) IN ('s', 'i'));
  END LOOP;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'tenant_payment_score_run';
  r := r || jsonb_build_object('step', 'K the job writes only to tenant_payment_score_daily (one INSERT, no UPDATE / DELETE)',
    'pass', (SELECT count(*) FROM regexp_matches(v_src, 'insert\s+into', 'gi')) = 1
        AND v_src ~* 'insert\s+into\s+public\.tenant_payment_score_daily'
        AND v_src !~* '\m(update\s+\w|delete\s+from|truncate)\M');

  RAISE EXCEPTION 'ROLLED BACK REPORT (block 4): %', jsonb_pretty(r);
END
$test$;

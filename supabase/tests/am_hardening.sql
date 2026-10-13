-- Rolled-back verification for 20261013180000_am_uncovered_and_clock_drift.sql
--
-- Run against the live database. Read-only: everything is rolled back, and the block ends in
-- RAISE EXCEPTION so the error text IS the report (a JSON list of steps with "pass").
--
--   A  access: staff roles may call am_uncovered_plans and the drift status; a user without a role and a
--      signed-out call are refused; the check and the helpers are not callable from the API
--   B  am_uncovered_plans: exactly the live plans in the two uncovered buckets, with the bucket am_plan_clock
--      gives, stable paging, payout state rebuilt independently, and a staff role that cannot read float
--      allocations directly still sees the part-paid amount
--   C  _am_plan_arrears_core equals am_plan_arrears for every live plan
--   D  live plans with no saved start (tops_plan_clock) are all in the Workspace's shared clock when counted,
--      and listed as landlord-not-paid when not; nothing is written to tops_plan_clock
--   E  drift check: as built it finds no unexplained difference (hand-set override starts are explained);
--      a deliberately broken Weekly function is caught, recorded with a system_event; a hand-set start records
--      the UGX difference in due and arrears; the record is append-only
--   F  the status line reads the latest run; the daily job is scheduled at 06:00 Kampala
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_staff uuid;
  v_plain uuid;
  v_role text;
  v_user uuid;
  v_ok boolean;
  v_live uuid[];
  v_json jsonb;
  v_def text;
  v_new text;
  v_plan uuid;
  v_start date;
  n_a int; n_b int; n_c int; n_d int;
  v_x numeric; v_y numeric;
  v_before int;
  v_evt_before int;
BEGIN
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'tenant_ops' AND enabled LIMIT 1;
  SELECT p.id INTO v_plain FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) LIMIT 1;
  SELECT ARRAY(SELECT id FROM public.rent_requests WHERE status IN ('funded', 'disbursed', 'repaying')) INTO v_live;

  -- A: access --------------------------------------------------------------------
  FOREACH v_role IN ARRAY ARRAY['manager','super_admin','coo','ceo','cto','cfo','operations','tenant_ops','agent_ops','financial_ops'] LOOP
    SELECT user_id INTO v_user FROM public.user_roles WHERE role::text = v_role AND enabled LIMIT 1;
    IF v_user IS NULL THEN
      r := r || jsonb_build_object('step', 'A role ' || v_role, 'pass', NULL, 'detail', 'skipped: no enabled user holds this role');
      CONTINUE;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    v_ok := true;
    BEGIN
      PERFORM 1 FROM public.am_uncovered_plans(v_today, 5, 0);
      PERFORM 1 FROM public.get_am_clock_drift_status();
    EXCEPTION WHEN OTHERS THEN v_ok := false;
    END;
    r := r || jsonb_build_object('step', 'A role ' || v_role || ' can read the uncovered lists and the drift status', 'pass', v_ok);
  END LOOP;

  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false;
  BEGIN PERFORM 1 FROM public.am_uncovered_plans(v_today, 5, 0); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'A signed-out call refused (uncovered plans)', 'pass', v_ok);
  IF v_plain IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_plain, 'role', 'authenticated')::text, true);
    v_ok := false;
    BEGIN PERFORM 1 FROM public.am_uncovered_plans(v_today, 5, 0); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    r := r || jsonb_build_object('step', 'A user without a role refused (uncovered plans)', 'pass', v_ok);
    v_ok := false;
    BEGIN PERFORM 1 FROM public.get_am_clock_drift_status(); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    r := r || jsonb_build_object('step', 'A user without a role refused (drift status)', 'pass', v_ok);
  END IF;
  r := r || jsonb_build_object('step', 'A the drift check and the helpers are not callable by authenticated, anon or service_role; the tables are not readable',
    'pass', NOT has_function_privilege('authenticated', 'public.am_detect_clock_drift(date)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.am_detect_clock_drift(date)', 'EXECUTE')
        AND NOT has_function_privilege('service_role', 'public.am_detect_clock_drift(date)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public._am_plan_arrears_core(uuid[],date)', 'EXECUTE')
        AND has_function_privilege('authenticated', 'public.am_uncovered_plans(date,integer,integer)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.am_uncovered_plans(date,integer,integer)', 'EXECUTE')
        AND NOT has_table_privilege('authenticated', 'public.am_clock_drift_daily', 'SELECT')
        AND NOT has_table_privilege('authenticated', 'public.am_clock_drift_runs', 'SELECT'));

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);

  -- B: the uncovered lists ----------------------------------------------------------
  CREATE TEMP TABLE _clk ON COMMIT DROP AS SELECT * FROM public.am_plan_clock(v_live);
  CREATE TEMP TABLE _unc ON COMMIT DROP AS SELECT * FROM public.am_uncovered_plans(v_today, 1000, 0);

  SELECT count(*) INTO n_a FROM _clk WHERE bucket IN ('tenant_paying_no_landlord', 'awaiting_landlord');
  SELECT count(*) INTO n_b FROM _unc u JOIN _clk c ON c.rent_request_id = u.rent_request_id AND c.bucket = u.bucket;
  r := r || jsonb_build_object('step', 'B exactly the live plans in the two uncovered buckets, each with the bucket am_plan_clock gives',
    'pass', n_a = (SELECT count(*) FROM _unc) AND n_b = n_a AND n_a > 0
        AND NOT EXISTS (SELECT 1 FROM _unc WHERE bucket NOT IN ('tenant_paying_no_landlord', 'awaiting_landlord')),
    'detail', jsonb_build_object('uncovered_plans', n_a,
        'tenant_paying', (SELECT count(*) FROM _unc WHERE bucket = 'tenant_paying_no_landlord'),
        'awaiting', (SELECT count(*) FROM _unc WHERE bucket = 'awaiting_landlord')));

  -- paging: pages of 7 rebuild the same list, no repeats, the same total on every page
  CREATE TEMP TABLE _pg ON COMMIT DROP AS
    SELECT p.* FROM generate_series(0, 200, 7) o, LATERAL public.am_uncovered_plans(v_today, 7, o) p;
  r := r || jsonb_build_object('step', 'B paging: pages of 7 rebuild the same list with no repeats and a constant total',
    'pass', (SELECT count(*) FROM _pg) = (SELECT count(*) FROM _unc)
        AND (SELECT count(DISTINCT rent_request_id) FROM _pg) = (SELECT count(*) FROM _unc)
        AND (SELECT count(DISTINCT total_rows) FROM _pg) = 1
        AND (SELECT min(total_rows) FROM _pg) = (SELECT count(*) FROM _unc));

  -- money columns equal the plan; days are counted to the day asked for
  SELECT count(*) INTO n_a FROM _unc u JOIN public.rent_requests rr ON rr.id = u.rent_request_id
   WHERE u.repaid <> COALESCE(rr.amount_repaid, 0) OR u.total_repayment <> COALESCE(rr.total_repayment, 0)
      OR u.funded_amount <> COALESCE(rr.rent_amount, 0)
      OR u.still_owed <> GREATEST(0, COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0))
      OR u.days_since_funding <> GREATEST(0, v_today - u.funded_on)
      OR u.pipeline_status <> rr.status;
  r := r || jsonb_build_object('step', 'B amounts, days and status equal the Rent Plan', 'pass', n_a = 0, 'detail', jsonb_build_object('differences', n_a));

  -- payout state rebuilt independently from the payout and allocation rows
  CREATE TEMP TABLE _kind ON COMMIT DROP AS
    SELECT u.rent_request_id,
           (SELECT COALESCE(sum(a.paid_out_amount) FILTER (WHERE a.status <> 'cancelled'), 0)
              FROM public.agent_landlord_float_allocations a WHERE a.rent_request_id = u.rent_request_id) AS paid,
           (SELECT COALESCE(sum(a.allocated_amount) FILTER (WHERE a.status <> 'cancelled'), 0)
              FROM public.agent_landlord_float_allocations a WHERE a.rent_request_id = u.rent_request_id) AS allocated,
           EXISTS (SELECT 1 FROM public.agent_landlord_float_allocations a WHERE a.rent_request_id = u.rent_request_id AND a.status = 'fully_paid') AS has_full,
           EXISTS (SELECT 1 FROM public.landlord_payouts p WHERE p.rent_request_id = u.rent_request_id AND p.status IN ('otp_verified', 'pending_finops_disbursement', 'pending_merchant_payout', 'disbursing', 'escalated')) AS pending,
           (SELECT count(*) FROM public.landlord_payouts p WHERE p.rent_request_id = u.rent_request_id) AS n_payouts,
           NOT EXISTS (SELECT 1 FROM public.landlord_payouts p WHERE p.rent_request_id = u.rent_request_id AND p.status <> 'failed') AS all_failed
      FROM _unc u;
  SELECT count(*) INTO n_a FROM _unc u JOIN _kind k ON k.rent_request_id = u.rent_request_id
   WHERE u.payout_kind IS DISTINCT FROM CASE
           WHEN k.paid > 0 THEN CASE WHEN k.has_full AND k.paid >= k.allocated THEN 'paid_unrecorded' ELSE 'part_paid' END
           WHEN k.pending THEN 'pending'
           WHEN k.n_payouts > 0 AND k.all_failed THEN 'failed'
           ELSE 'none' END
      OR u.payout_paid_amount <> k.paid OR u.payout_allocated_amount <> k.allocated;
  r := r || jsonb_build_object('step', 'B payout state and the part-paid amount equal an independent rebuild from the payout and allocation rows',
    'pass', n_a = 0,
    'detail', jsonb_build_object('differences', n_a,
        'none', (SELECT count(*) FROM _unc WHERE payout_kind = 'none'), 'pending', (SELECT count(*) FROM _unc WHERE payout_kind = 'pending'),
        'failed', (SELECT count(*) FROM _unc WHERE payout_kind = 'failed'), 'part_paid', (SELECT count(*) FROM _unc WHERE payout_kind = 'part_paid'),
        'paid_unrecorded', (SELECT count(*) FROM _unc WHERE payout_kind = 'paid_unrecorded')));

  -- a signed-in staff role (not a finance role) sees the part-paid amount even though it cannot read the allocations table
  SELECT count(*) INTO n_a FROM _unc WHERE payout_paid_amount > 0;
  SET LOCAL ROLE authenticated;
  BEGIN
    SELECT count(*) INTO n_b FROM public.am_uncovered_plans(v_today, 1000, 0) WHERE payout_paid_amount > 0;
    BEGIN
      SELECT count(*) INTO n_c FROM public.agent_landlord_float_allocations;
    EXCEPTION WHEN OTHERS THEN n_c := -1;
    END;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RAISE;
  END;
  RESET ROLE;
  r := r || jsonb_build_object('step', 'B as the API role, the staff user still sees every part-paid amount (the table is not directly readable for that role)',
    'pass', n_b = n_a,
    'detail', jsonb_build_object('rows_with_paid_amount', n_b, 'direct_table_rows_visible', n_c));
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);

  -- C: the ungated core equals am_plan_arrears ---------------------------------------
  CREATE TEMP TABLE _a1 ON COMMIT DROP AS SELECT * FROM public.am_plan_arrears(v_live, v_today);
  CREATE TEMP TABLE _a2 ON COMMIT DROP AS SELECT * FROM public._am_plan_arrears_core(v_live, v_today);
  SELECT count(*) INTO n_a FROM (SELECT * FROM _a1 EXCEPT SELECT * FROM _a2) q;
  SELECT count(*) INTO n_b FROM (SELECT * FROM _a2 EXCEPT SELECT * FROM _a1) q;
  r := r || jsonb_build_object('step', 'C _am_plan_arrears_core returns exactly what am_plan_arrears returns for every live plan',
    'pass', n_a = 0 AND n_b = 0 AND (SELECT count(*) FROM _a1) = cardinality(v_live),
    'detail', jsonb_build_object('plans', cardinality(v_live), 'rows_only_in_original', n_a, 'rows_only_in_core', n_b));

  -- D: live plans with no saved start ---------------------------------------------------
  SELECT count(*) INTO v_before FROM public.tops_plan_clock;
  CREATE TEMP TABLE _nocl ON COMMIT DROP AS
    SELECT id FROM public.rent_requests rr
     WHERE rr.status IN ('funded', 'disbursed', 'repaying')
       AND NOT EXISTS (SELECT 1 FROM public.tops_plan_clock t WHERE t.rent_request_id = rr.id);
  SELECT count(*) INTO n_a FROM _nocl n JOIN _clk c ON c.rent_request_id = n.id AND c.bucket IN ('counting', 'outstanding_balance');
  SELECT count(*) INTO n_b FROM public.tops_plan_clock_amclock() w WHERE w.rent_request_id IN (SELECT id FROM _nocl);
  SELECT count(*) INTO n_c FROM _nocl n JOIN _unc u ON u.rent_request_id = n.id;
  SELECT count(*) INTO n_d FROM public.tops_plan_clock;
  r := r || jsonb_build_object('step', 'D every counted live plan with no saved start is in the Workspace shared clock; the rest are listed as landlord-not-paid; nothing was inserted',
    'pass', n_a = n_b AND n_a + n_c = (SELECT count(*) FROM _nocl) AND v_before = n_d,
    'detail', jsonb_build_object('live_plans_without_a_saved_start', (SELECT count(*) FROM _nocl),
        'counted_and_in_workspace_clock', n_b, 'counted', n_a, 'landlord_not_paid', n_c));

  -- E: the drift check --------------------------------------------------------------------
  SELECT count(*) INTO v_evt_before FROM public.system_events WHERE event_type = 'am_clock_drift_detected';
  v_json := public.am_detect_clock_drift(v_today);
  SELECT count(*) INTO n_a FROM public.tops_plan_clock WHERE clock_source = 'override'
     AND rent_request_id IN (SELECT rent_request_id FROM _clk WHERE bucket IN ('tenant_paying_no_landlord', 'awaiting_landlord'));
  r := r || jsonb_build_object('step', 'E as built, no plan is counted from a different start: unexplained = 0 (hand-set override starts are explained), no system_event',
    'pass', (v_json->>'plans_differ')::int = 0 AND (v_json->>'plans_explained')::int = n_a
        AND NOT (v_json->>'event_emitted')::boolean
        AND (v_json->>'plans_checked')::int = cardinality(v_live)
        AND (SELECT count(*) FROM public.system_events WHERE event_type = 'am_clock_drift_detected') = v_evt_before
        AND NOT EXISTS (SELECT 1 FROM public.am_clock_drift_daily WHERE run_id = (v_json->>'run_id')::bigint AND NOT explained),
    'detail', v_json);

  -- a deliberately broken Weekly function (clock_start one day late) is caught and recorded
  v_def := pg_get_functiondef('public._tenant_ops_weekly_amclock_plans(date,date)'::regprocedure);
  v_new := replace(v_def, E'         p.clock_start,\n         p.counted,', E'         (p.clock_start + 1),\n         p.counted,');
  IF v_new = v_def THEN RAISE EXCEPTION 'test setup: the Weekly function text did not match'; END IF;
  EXECUTE v_new;
  v_json := public.am_detect_clock_drift(v_today);
  SELECT count(*) INTO n_a FROM public.am_clock_drift_daily WHERE run_id = (v_json->>'run_id')::bigint AND page = 'weekly' AND reason LIKE '%clock_start_differs%' AND NOT explained;
  r := r || jsonb_build_object('step', 'E a Weekly function that starts plans a day late is caught: plans differ, recorded per plan, a system_event is emitted',
    'pass', (v_json->>'plans_differ')::int > 0 AND (v_json->>'event_emitted')::boolean AND n_a = (v_json->>'plans_differ')::int
        AND (SELECT count(*) FROM public.system_events WHERE event_type = 'am_clock_drift_detected') = v_evt_before + 1,
    'detail', v_json);
  -- put the real function back inside this rolled-back block so the next steps are clean
  EXECUTE v_def;

  -- a hand-set start records the UGX difference in due and arrears (explained: kept by decision)
  SELECT c.rent_request_id, c.clock_start INTO v_plan, v_start
    FROM _clk c JOIN public.rent_requests rr ON rr.id = c.rent_request_id
   WHERE c.bucket = 'counting' AND c.clock_start < v_today - 20 AND COALESCE(rr.daily_repayment, 0) > 0
     AND NOT EXISTS (SELECT 1 FROM public.tops_plan_clock t WHERE t.rent_request_id = c.rent_request_id)
   ORDER BY c.rent_request_id LIMIT 1;
  INSERT INTO public.tops_plan_clock (rent_request_id, clock_start, clock_source, cadence, cadence_source)
  VALUES (v_plan, v_start - 10, 'override', 'daily', 'explicit');
  v_json := public.am_detect_clock_drift(v_today);
  SELECT due_diff_ugx, arrears_diff_ugx INTO v_x, v_y FROM public.am_clock_drift_daily
   WHERE run_id = (v_json->>'run_id')::bigint AND rent_request_id = v_plan AND page = 'workspace';
  r := r || jsonb_build_object('step', 'E a hand-set start is recorded with the UGX difference in due and arrears and is marked explained',
    'pass', v_x IS NOT NULL AND v_x <> 0
        AND EXISTS (SELECT 1 FROM public.am_clock_drift_daily WHERE run_id = (v_json->>'run_id')::bigint AND rent_request_id = v_plan AND explained AND reason LIKE '%clock_start_differs%'),
    'detail', jsonb_build_object('plan', left(v_plan::text, 8), 'due_diff_ugx', v_x, 'arrears_diff_ugx', v_y));

  -- append-only
  v_ok := false;
  BEGIN UPDATE public.am_clock_drift_daily SET reason = 'x'; EXCEPTION WHEN OTHERS THEN v_ok := true; END;
  r := r || jsonb_build_object('step', 'E the drift rows cannot be updated', 'pass', v_ok);
  v_ok := false;
  BEGIN DELETE FROM public.am_clock_drift_daily; EXCEPTION WHEN OTHERS THEN v_ok := true; END;
  r := r || jsonb_build_object('step', 'E the drift rows cannot be deleted', 'pass', v_ok);
  v_ok := false;
  BEGIN UPDATE public.am_clock_drift_runs SET plans_differ = 0; EXCEPTION WHEN OTHERS THEN v_ok := true; END;
  r := r || jsonb_build_object('step', 'E the run records cannot be updated', 'pass', v_ok);
  v_ok := false;
  BEGIN DELETE FROM public.am_clock_drift_runs; EXCEPTION WHEN OTHERS THEN v_ok := true; END;
  r := r || jsonb_build_object('step', 'E the run records cannot be deleted', 'pass', v_ok);

  -- F: status line and schedule -------------------------------------------------------------
  SELECT to_jsonb(s) INTO v_json FROM public.get_am_clock_drift_status() s;
  r := r || jsonb_build_object('step', 'F the status line reads the latest run',
    'pass', v_json IS NOT NULL AND (v_json->>'run_date')::date = v_today
        AND (v_json->>'plans_checked')::int = cardinality(v_live),
    'detail', v_json);
  r := r || jsonb_build_object('step', 'F the daily job is scheduled at 06:00 Kampala (03:00 UTC)',
    'pass', EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'am-clock-drift-daily-0600-eat' AND schedule = '0 3 * * *'
                      AND command LIKE '%am_detect_clock_drift%'));

  RAISE EXCEPTION 'ROLLED BACK REPORT: %', jsonb_pretty(r);
END
$test$;

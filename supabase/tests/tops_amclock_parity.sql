-- Rolled-back verification for 20261012180000_tops_workspace_amclock.sql
--
-- Run against the live database. Read-only: nothing is written, and the block ends in RAISE
-- EXCEPTION so the error text IS the report (a JSON list of steps with "pass"). Every step must pass.
--
--   A  access: Workspace roles may read, a user without a role and a signed-out call are refused
--   B  the shared clock: the internal helper equals am_plan_clock for every Rent Plan
--   C  every generated function has the same arguments, return shape, security and search_path as the
--      function it replaces, and no generated body still reads the saved clock or the saved instalments
--   D  parity: for the same Rent Plan and day, the Workspace's due and arrears equal am_plan_arrears
--      (three different days, every live plan except the hand-set override rows)
--   E  a Rent Plan with no counted landlord payout is never in arrears, due, the clock or the position
--   F  the two hand-set 'override' rows are used exactly as saved and are NOT in the not-paid count
--   G  the Workspace roll-ups add up: ageing buckets + never-billed = the instalments' total
--   H  the Workspace's plan position agrees with am_plan_arrears for the same plan and day
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_staff uuid;
  v_plain uuid;
  v_live uuid[];
  v_all uuid[];
  v_ok boolean;
  v_day date;
  n_bad int;
  n_checked int;
  v_detail jsonb;
  v_a numeric; v_b numeric; v_c numeric;
BEGIN
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'tenant_ops' AND enabled LIMIT 1;
  SELECT p.id INTO v_plain FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) LIMIT 1;
  SELECT array_agg(id) INTO v_live FROM public.rent_requests WHERE status IN ('funded', 'disbursed', 'repaying');
  SELECT array_agg(id) INTO v_all FROM public.rent_requests;

  -- A: access ----------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false;
  BEGIN PERFORM 1 FROM public.tops_plan_schedule_ledger_count_amclock(v_live[1]); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM = 'not authorized'; END;
  r := r || jsonb_build_object('step', 'A signed-out call refused (ledger count)', 'pass', v_ok);
  v_ok := false;
  BEGIN PERFORM 1 FROM public.tops_landlord_not_paid_summary_amclock(); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM = 'not authorized'; END;
  r := r || jsonb_build_object('step', 'A signed-out call refused (not-paid summary)', 'pass', v_ok);
  IF v_plain IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_plain, 'role', 'authenticated')::text, true);
    v_ok := false;
    BEGIN PERFORM 1 FROM public.tops_plan_position_amclock(v_live[1], v_today); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM = 'not authorized'; END;
    r := r || jsonb_build_object('step', 'A user without a role refused (plan position)', 'pass', v_ok);
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);

  -- B: shared clock --------------------------------------------------------------
  SELECT count(*) INTO n_bad
    FROM public._am_plan_clock_core(v_all) k
    JOIN public.am_plan_clock(v_all) a USING (rent_request_id)
   WHERE k.bucket IS DISTINCT FROM a.bucket OR k.clock_start IS DISTINCT FROM a.clock_start
      OR k.clock_end IS DISTINCT FROM a.clock_end OR k.landlord_paid_count IS DISTINCT FROM a.landlord_paid_count
      OR k.last_landlord_paid_on IS DISTINCT FROM a.last_landlord_paid_on;
  r := r || jsonb_build_object('step', 'B the internal clock equals am_plan_clock for every Rent Plan', 'pass', n_bad = 0,
        'detail', jsonb_build_object('plans', cardinality(v_all), 'mismatches', n_bad));

  -- C: shapes and no leftover old start --------------------------------------------
  SELECT count(*) INTO n_bad
    FROM pg_proc a JOIN pg_proc o ON o.pronamespace = a.pronamespace AND o.proname = replace(a.proname, '_amclock', '') AND o.proname <> a.proname
   WHERE a.pronamespace = 'public'::regnamespace AND a.proname LIKE '%\_amclock'
     AND (pg_get_function_identity_arguments(a.oid) IS DISTINCT FROM pg_get_function_identity_arguments(o.oid)
          OR pg_get_function_result(a.oid) IS DISTINCT FROM pg_get_function_result(o.oid)
          OR a.prosecdef IS DISTINCT FROM o.prosecdef
          OR NOT EXISTS (SELECT 1 FROM unnest(a.proconfig) x WHERE x LIKE 'search_path=%'));
  SELECT count(*) INTO n_checked
    FROM pg_proc a JOIN pg_proc o ON o.pronamespace = a.pronamespace AND o.proname = replace(a.proname, '_amclock', '') AND o.proname <> a.proname
   WHERE a.pronamespace = 'public'::regnamespace AND a.proname LIKE '%\_amclock';
  r := r || jsonb_build_object('step', 'C same arguments, return shape, security and search_path as the function replaced', 'pass', n_bad = 0 AND n_checked >= 30,
        'detail', jsonb_build_object('pairs_checked', n_checked, 'differences', n_bad));
  SELECT count(*) INTO n_bad
    FROM pg_proc a
   WHERE a.pronamespace = 'public'::regnamespace AND a.proname LIKE '%\_amclock' AND a.proname NOT LIKE '\_%'
     AND pg_get_functiondef(a.oid) ~ '\m(tops_plan_instalments|tops_instalment_settlements|tops_resolve_plan_clock|tops_build_plan_instalments)\M'
     AND a.proname NOT IN ('tops_plan_clock_amclock');
  r := r || jsonb_build_object('step', 'C no generated function reads the saved instalments or settlements', 'pass', n_bad = 0, 'detail', jsonb_build_object('offenders', n_bad));

  -- D: parity with am_plan_arrears on three days ---------------------------------------
  CREATE TEMP TABLE _ov ON COMMIT DROP AS SELECT rent_request_id FROM public.tops_plan_clock WHERE clock_source = 'override';
  FOREACH v_day IN ARRAY ARRAY[v_today, v_today - 30, v_today - 90] LOOP
    SELECT count(*), count(*) FILTER (WHERE abs(COALESCE(w.due, 0) - a.expected_to_date) > 0.5 OR abs(COALESCE(w.arrears, 0) - a.arrears) > 0.5)
      INTO n_checked, n_bad
      FROM public.am_plan_arrears(v_live, v_day) a
      LEFT JOIN (
        SELECT s.rent_request_id,
               SUM(s.amount_ugx) FILTER (WHERE s.due_date <= v_day) AS due,
               SUM(s.outstanding_ugx) FILTER (WHERE s.due_date <= v_day AND s.outstanding_ugx > 0) AS arrears
          FROM public._tops_am_schedule(NULL, v_day) s GROUP BY s.rent_request_id
      ) w ON w.rent_request_id = a.rent_request_id
     WHERE a.bucket IN ('counting', 'outstanding_balance')
       AND a.rent_request_id NOT IN (SELECT rent_request_id FROM _ov);
    r := r || jsonb_build_object('step', 'D due and arrears equal am_plan_arrears on ' || v_day::text, 'pass', n_bad = 0,
          'detail', jsonb_build_object('plans_compared', n_checked, 'mismatches', n_bad));
  END LOOP;

  -- the public function the screens call returns the same open amounts
  SELECT COALESCE(SUM(o.outstanding_ugx), 0) INTO v_a FROM public.tops_open_instalments_asof_amclock(v_today) o WHERE o.rent_request_id NOT IN (SELECT rent_request_id FROM _ov);
  SELECT COALESCE(SUM(a.arrears), 0) INTO v_b FROM public.am_plan_arrears(v_live, v_today) a WHERE a.bucket IN ('counting', 'outstanding_balance') AND a.rent_request_id NOT IN (SELECT rent_request_id FROM _ov);
  r := r || jsonb_build_object('step', 'D tops_open_instalments_asof_amclock totals the same arrears as am_plan_arrears', 'pass', abs(v_a - v_b) < 1,
        'detail', jsonb_build_object('workspace', v_a, 'agent_monitoring', v_b));

  -- E: no paid payout, never owed ----------------------------------------------------------
  CREATE TEMP TABLE _np ON COMMIT DROP AS
    SELECT c.rent_request_id, c.bucket FROM public.am_plan_clock(v_all) c
     WHERE c.bucket IN ('tenant_paying_no_landlord', 'awaiting_landlord') AND c.rent_request_id NOT IN (SELECT rent_request_id FROM _ov);
  SELECT count(*) INTO n_bad FROM public.tops_open_instalments_asof_amclock(v_today) o WHERE o.rent_request_id IN (SELECT rent_request_id FROM _np);
  r := r || jsonb_build_object('step', 'E plans with no counted landlord payout are never in arrears or due', 'pass', n_bad = 0,
        'detail', jsonb_build_object('such_plans', (SELECT count(*) FROM _np), 'rows_found', n_bad));
  SELECT count(*) INTO n_bad FROM public.tops_plan_clock_amclock() c WHERE c.rent_request_id IN (SELECT rent_request_id FROM _np);
  r := r || jsonb_build_object('step', 'E ... and have no clock row', 'pass', n_bad = 0);
  SELECT count(*) INTO n_bad FROM (SELECT public.tops_arrears_ageing_amclock(v_today, NULL, 1000, 0, 'desc') AS j) x, jsonb_array_elements(x.j->'rows') e
   WHERE (e->>'rent_request_id')::uuid IN (SELECT rent_request_id FROM _np);
  r := r || jsonb_build_object('step', 'E ... and are not in the arrears ageing list', 'pass', n_bad = 0);
  SELECT count(*) INTO n_bad FROM public.tops_plan_position_amclock((SELECT rent_request_id FROM _np ORDER BY 1 LIMIT 1), v_today) p
   WHERE p.cadence_source <> 'unknown' OR p.position_ugx IS NOT NULL OR p.expected_to_date_ugx IS NOT NULL OR p.clock_start IS NOT NULL;
  r := r || jsonb_build_object('step', 'E ... and their plan position is never a number', 'pass', n_bad = 0);
  SELECT jsonb_build_object('tenant_paying', tenant_paying_no_landlord, 'awaiting', awaiting_landlord, 'total', total_plans) INTO v_detail
    FROM public.tops_landlord_not_paid_summary_amclock();
  SELECT count(*) INTO n_checked FROM _np n JOIN public.rent_requests rr ON rr.id = n.rent_request_id WHERE rr.status IN ('funded', 'disbursed', 'repaying');
  r := r || jsonb_build_object('step', 'E the not-paid count equals the live plans with no counted payout (overrides excluded)',
        'pass', (v_detail->>'total')::int = n_checked, 'detail', v_detail);

  -- F: overrides kept exactly as saved ----------------------------------------------------------
  SELECT count(*) INTO n_bad
    FROM public.tops_plan_clock t
    LEFT JOIN public.tops_plan_clock_amclock() c ON c.rent_request_id = t.rent_request_id
   WHERE t.clock_source = 'override'
     AND (c.rent_request_id IS NULL OR c.clock_start <> t.clock_start OR c.cadence <> t.cadence OR c.clock_source <> 'override'
          OR c.override_reason IS DISTINCT FROM t.override_reason);
  r := r || jsonb_build_object('step', 'F override rows are returned exactly as saved', 'pass', n_bad = 0,
        'detail', jsonb_build_object('override_rows', (SELECT count(*) FROM _ov)));
  SELECT count(*) INTO n_bad
    FROM (SELECT t.rent_request_id, t.clock_start + 1 AS expected_first_due
            FROM public.tops_plan_clock t WHERE t.clock_source = 'override' AND t.cadence = 'daily') t
    LEFT JOIN LATERAL (SELECT MIN(s.due_date) AS first_due FROM public._tops_am_schedule(ARRAY[t.rent_request_id], v_today) s) f ON true
   WHERE f.first_due IS DISTINCT FROM t.expected_first_due;
  r := r || jsonb_build_object('step', 'F a daily override keeps the saved convention (first instalment the day after its start)', 'pass', n_bad = 0);

  -- G: roll-ups add up ----------------------------------------------------------------------------------
  SELECT COALESCE(SUM((x.value->>'arrears_ugx')::numeric), 0) INTO v_a
    FROM (SELECT public.tops_arrears_ageing_amclock(v_today, NULL, 1, 0, 'desc') AS j) g, jsonb_each(g.j->'summary') x;
  SELECT COALESCE((public.tops_never_billed_summary_amclock(v_today)->>'arrears_ugx')::numeric, 0) INTO v_b;
  SELECT COALESCE(SUM(o.outstanding_ugx), 0) INTO v_c FROM public.tops_open_instalments_asof_amclock(v_today) o;
  r := r || jsonb_build_object('step', 'G ageing buckets + never-billed = the open instalments total', 'pass', abs(v_a + v_b - v_c) < 1,
        'detail', jsonb_build_object('ageing', v_a, 'never_billed', v_b, 'open_instalments', v_c));

  -- H: plan position agrees with am_plan_arrears ------------------------------------------------------------
  SELECT count(*), count(*) FILTER (WHERE abs(p.expected_to_date_ugx - LEAST(a.expected_to_date, rr.total_repayment)) > 0.5
                                       OR abs((p.expected_to_date_ugx - p.paid_to_date_ugx) - LEAST(a.expected_to_date, rr.total_repayment) + LEAST(a.paid_to_date, rr.total_repayment)) > 0.5)
    INTO n_checked, n_bad
    FROM (SELECT c.rent_request_id FROM public.am_plan_clock(v_live) c
           WHERE c.bucket IN ('counting', 'outstanding_balance') AND c.rent_request_id NOT IN (SELECT rent_request_id FROM _ov)
           ORDER BY c.rent_request_id LIMIT 60) s
    CROSS JOIN LATERAL public.tops_plan_position_amclock(s.rent_request_id, v_today) p
    JOIN public.am_plan_arrears(ARRAY[s.rent_request_id], v_today) a ON a.rent_request_id = s.rent_request_id
    JOIN public.rent_requests rr ON rr.id = s.rent_request_id;
  r := r || jsonb_build_object('step', 'H plan position expected and paid agree with am_plan_arrears (60 plans)', 'pass', n_bad = 0 AND n_checked >= 50,
        'detail', jsonb_build_object('plans_compared', n_checked, 'mismatches', n_bad));

  RAISE EXCEPTION 'ROLLED BACK REPORT: %', jsonb_pretty(r);
END
$test$;

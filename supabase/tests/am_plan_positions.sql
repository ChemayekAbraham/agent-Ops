-- Rolled-back verification for 20261012150000_am_plan_positions_and_staff_gate.sql
--
-- Run against the live database. Read-only: nothing is written, and the block ends in
-- RAISE EXCEPTION so the error text IS the report (a JSON list of steps with "pass").
--
--   A  access: every role in _am_staff_ok may call the three clock functions; a user without
--      a role and a signed-out call are refused
--   B  population: am_plan_positions returns only counting / outstanding_balance plans, each
--      starting on its clock_start, and nothing from the two uncovered buckets
--   C  maths: expected_to_date equals an independent daily / weekly calculation from the
--      clock start; paid_to_date equals am_plan_arrears' paid_to_date
--   D  parity with the old function: plans whose clock start equals the stored start are
--      compared with get_agent_monitoring_positions (differences are listed, not hidden)
--   E  unattributed agent cash is reported exactly as before
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_staff uuid;
  v_plain uuid;
  v_role text;
  v_user uuid;
  v_ok boolean;
  v_ids uuid[];
  n_new int; n_old int; n_bad int; n_same int; n_diff int; n_checked int;
  v_diff jsonb;
BEGIN
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'tenant_ops' AND enabled LIMIT 1;
  SELECT p.id INTO v_plain FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) LIMIT 1;

  -- A: access --------------------------------------------------------------
  FOREACH v_role IN ARRAY ARRAY['manager','super_admin','coo','ceo','cto','cfo','operations','tenant_ops','agent_ops','financial_ops'] LOOP
    SELECT user_id INTO v_user FROM public.user_roles WHERE role::text = v_role AND enabled LIMIT 1;
    IF v_user IS NULL THEN
      r := r || jsonb_build_object('step', 'A role ' || v_role, 'pass', NULL, 'detail', 'skipped: no enabled user holds this role');
      CONTINUE;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    v_ok := true;
    BEGIN
      PERFORM 1 FROM public.am_plan_clock(ARRAY[gen_random_uuid()]);
      PERFORM 1 FROM public.am_plan_arrears(ARRAY[gen_random_uuid()], v_today);
      PERFORM 1 FROM public.am_plan_positions(v_today, v_today, true) LIMIT 1;
    EXCEPTION WHEN OTHERS THEN v_ok := false;
    END;
    r := r || jsonb_build_object('step', 'A role ' || v_role || ' can read the clock, arrears and positions', 'pass', v_ok);
  END LOOP;

  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false;
  BEGIN PERFORM 1 FROM public.am_plan_positions(v_today, v_today, true) LIMIT 1; EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'A signed-out call refused (positions)', 'pass', v_ok);
  IF v_plain IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_plain, 'role', 'authenticated')::text, true);
    v_ok := false;
    BEGIN PERFORM 1 FROM public.am_plan_positions(v_today, v_today, true) LIMIT 1; EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    r := r || jsonb_build_object('step', 'A user without a role refused (positions)', 'pass', v_ok);
    v_ok := false;
    BEGIN PERFORM 1 FROM public.am_plan_clock(ARRAY[gen_random_uuid()]); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    r := r || jsonb_build_object('step', 'A user without a role refused (clock)', 'pass', v_ok);
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);

  -- B: population ----------------------------------------------------------
  CREATE TEMP TABLE _new ON COMMIT DROP AS SELECT * FROM public.am_plan_positions(v_today, v_today, true);
  CREATE TEMP TABLE _old ON COMMIT DROP AS SELECT * FROM public.get_agent_monitoring_positions(v_today, v_today, true);
  SELECT count(*) INTO n_new FROM _new WHERE rent_request_id IS NOT NULL;
  SELECT count(*) INTO n_old FROM _old WHERE rent_request_id IS NOT NULL;
  SELECT array_agg(rent_request_id) INTO v_ids FROM _new WHERE rent_request_id IS NOT NULL;

  CREATE TEMP TABLE _clk ON COMMIT DROP AS SELECT * FROM public.am_plan_clock(ARRAY(SELECT rent_request_id FROM _old WHERE rent_request_id IS NOT NULL));
  SELECT count(*) INTO n_bad FROM _new n LEFT JOIN _clk c ON c.rent_request_id = n.rent_request_id
   WHERE n.rent_request_id IS NOT NULL AND (c.bucket NOT IN ('counting','outstanding_balance') OR c.clock_start IS DISTINCT FROM n.term_start);
  r := r || jsonb_build_object('step', 'B only counting / outstanding_balance plans, each starting on its clock_start',
        'pass', n_bad = 0, 'detail', jsonb_build_object('plans_new', n_new, 'plans_old', n_old, 'violations', n_bad));
  SELECT count(*) INTO n_bad FROM _old o JOIN _clk c ON c.rent_request_id = o.rent_request_id
   WHERE c.bucket IN ('tenant_paying_no_landlord','awaiting_landlord') AND o.rent_request_id IN (SELECT rent_request_id FROM _new);
  r := r || jsonb_build_object('step', 'B no plan from the two uncovered buckets', 'pass', n_bad = 0,
        'detail', jsonb_build_object('left_out', (SELECT count(*) FROM _old o JOIN _clk c ON c.rent_request_id = o.rent_request_id WHERE c.bucket IN ('tenant_paying_no_landlord','awaiting_landlord'))));

  -- C: maths ---------------------------------------------------------------
  SELECT count(*), count(*) FILTER (WHERE abs(n.expected_to_date - e.expected) > 0.5)
    INTO n_checked, n_bad
    FROM _new n
    JOIN public.rent_requests rr ON rr.id = n.rent_request_id
    CROSS JOIN LATERAL (
      SELECT CASE WHEN v_today < n.term_start THEN 0
                  ELSE least(n.total_repayment,
                       n.instalment_amount * least(
                         CASE n.frequency WHEN 'weekly' THEN ((v_today - n.term_start) / 7) + 1 ELSE (v_today - n.term_start) + 1 END,
                         CASE n.frequency WHEN 'weekly' THEN ceil(rr.duration_days::numeric / 7) ELSE rr.duration_days END)) END AS expected
    ) e
   WHERE n.rent_request_id IS NOT NULL AND n.frequency IN ('daily','weekly')
     AND n.obligation_end >= v_today;
  r := r || jsonb_build_object('step', 'C expected_to_date equals an independent daily / weekly calculation from the clock start',
        'pass', n_bad = 0, 'detail', jsonb_build_object('plans_checked', n_checked, 'mismatches', n_bad));

  SELECT count(*) INTO n_bad
    FROM _new n JOIN public.am_plan_arrears(v_ids, v_today) a ON a.rent_request_id = n.rent_request_id
   WHERE abs(n.paid_to_date - a.paid_to_date) > 0.5;
  r := r || jsonb_build_object('step', 'C paid_to_date equals am_plan_arrears paid_to_date for every plan', 'pass', n_bad = 0,
        'detail', jsonb_build_object('mismatches', n_bad));

  -- D: parity with the old function where the start did not move ---------------
  SELECT count(*), count(*) FILTER (WHERE abs(n.expected_to_date - o.expected_to_date) < 0.5 AND abs(n.paid_to_date - o.paid_to_date) < 0.5),
         count(*) FILTER (WHERE abs(n.expected_to_date - o.expected_to_date) >= 0.5 OR abs(n.paid_to_date - o.paid_to_date) >= 0.5)
    INTO n_checked, n_same, n_diff
    FROM _new n JOIN _old o ON o.rent_request_id = n.rent_request_id
    JOIN _clk c ON c.rent_request_id = n.rent_request_id
   WHERE c.shift_days = 0 AND n.rent_request_id IS NOT NULL;
  SELECT jsonb_agg(x) INTO v_diff FROM (
    SELECT left(n.rent_request_id::text, 8) AS plan, n.frequency, o.expected_to_date AS old_expected, n.expected_to_date AS new_expected,
           o.paid_to_date AS old_paid, n.paid_to_date AS new_paid
      FROM _new n JOIN _old o ON o.rent_request_id = n.rent_request_id JOIN _clk c ON c.rent_request_id = n.rent_request_id
     WHERE c.shift_days = 0 AND (abs(n.expected_to_date - o.expected_to_date) >= 0.5 OR abs(n.paid_to_date - o.paid_to_date) >= 0.5)
     ORDER BY abs(n.expected_to_date - o.expected_to_date) DESC LIMIT 8) x;
  r := r || jsonb_build_object('step', 'D parity with get_agent_monitoring_positions where the start did not move', 'pass', NULL,
        'detail', jsonb_build_object('compared', n_checked, 'identical', n_same, 'different', n_diff, 'largest_differences', v_diff));

  -- E: unattributed cash is unchanged -----------------------------------------
  SELECT count(*) INTO n_bad FROM (
    SELECT agent_id, paid_in_period_agent FROM _new WHERE rent_request_id IS NULL
    EXCEPT SELECT agent_id, paid_in_period_agent FROM _old WHERE rent_request_id IS NULL) q;
  r := r || jsonb_build_object('step', 'E unattributed agent cash identical to the old function', 'pass', n_bad = 0);

  RAISE EXCEPTION 'ROLLED BACK REPORT: %', jsonb_pretty(r);
END
$test$;

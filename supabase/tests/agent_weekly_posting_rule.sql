-- Rolled-back verification for 20261023130000_agent_weekly_posting_rule.sql
--
-- Run against the live database after the migration is applied. Nothing below survives: the block
-- ends in RAISE EXCEPTION so the error text IS the report (steps with "pass").
--
--   A  week arithmetic: every day Thu..Wed maps to the same Thursday; the judged week is the last completed one
--   B  saved results equal a live recompute, and every row's pass/fail follows from its own columns
--   C  each plan's collected never exceeds its due (overpayment cap), groups add up
--   D  access: an agent reads itself; a plain agent cannot read an unrelated agent; anon cannot call
--   E  the gate: with enforce_weekly on, a failing agent's result blocks and a passing one does not
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_week date;
  v_d date;
  v_ok boolean;
  v_msg text;
  v_fail uuid;
  v_pass uuid;
  v_other uuid;
  v_row public.agent_weekly_posting_eligibility;
  v_n int;
BEGIN
  -- A ---------------------------------------------------------------------------
  v_ok := true;
  FOR v_d IN SELECT date '2026-10-22' + generate_series(0, 6) LOOP
    IF public._agent_rule_week_start(v_d) <> date '2026-10-22' THEN v_ok := false; END IF;
  END LOOP;
  r := r || jsonb_build_object('step', 'A Thu 22 Oct .. Wed 28 Oct share week 22 Oct', 'pass', v_ok);
  r := r || jsonb_build_object('step', 'A Wed 21 Oct belongs to week 15 Oct',
                               'pass', public._agent_rule_week_start(date '2026-10-21') = date '2026-10-15');
  v_week := public._agent_rule_judged_week_start();
  r := r || jsonb_build_object('step', 'A judged week ended before today',
                               'pass', v_week + 6 < (now() AT TIME ZONE 'Africa/Kampala')::date
                                   AND v_week + 13 >= (now() AT TIME ZONE 'Africa/Kampala')::date,
                               'detail', v_week);

  -- B ---------------------------------------------------------------------------
  SELECT count(*) INTO v_n FROM public.agent_weekly_posting_eligibility WHERE week_start = v_week;
  r := r || jsonb_build_object('step', 'B snapshot exists for judged week', 'pass', v_n > 0, 'detail', v_n);

  SELECT bool_and(l.passes = s.passes AND l.in_window_due = s.in_window_due AND l.expired_due = s.expired_due)
    INTO v_ok
  FROM public.agent_weekly_posting_eligibility s
  CROSS JOIN LATERAL public._agent_weekly_posting_compute(s.week_start, ARRAY[s.agent_id]) l
  WHERE s.week_start = v_week;
  r := r || jsonb_build_object('step', 'B saved = live recompute (no collections backdated since)', 'pass', v_ok);

  SELECT bool_and(passes = (
           CASE book
             WHEN 'in_window_only' THEN in_window_collected >= 0.50 * in_window_due
             WHEN 'mixed'          THEN in_window_collected >= 0.50 * in_window_due AND expired_collected >= 0.20 * expired_due
             WHEN 'all_expired'    THEN expired_collected >= 0.70 * expired_due
             ELSE true END)
         AND (passes OR reason IS NOT NULL))
    INTO v_ok
  FROM public.agent_weekly_posting_eligibility WHERE week_start = v_week;
  r := r || jsonb_build_object('step', 'B pass/fail follows 50 / 20 / 70 and every block has a reason', 'pass', v_ok);

  -- C ---------------------------------------------------------------------------
  -- Since 20261026090000 a plan finished during the week may count above its bill (up to what was
  -- left), so the cap is checked per plan in weekly_rule_count_plan_payoff.sql; here only that a group
  -- can exceed its bill solely through finished plans.
  SELECT bool_and((in_window_plans > 0) = (in_window_due > 0) AND (expired_plans > 0) = (expired_due > 0))
     AND bool_and((in_window_collected <= in_window_due AND expired_collected <= expired_due)
                  OR EXISTS (SELECT 1 FROM public.agent_expected_day_plans e
                             JOIN public.rent_requests rr ON rr.id = e.rent_request_id
                             WHERE e.agent_id = agent_weekly_posting_eligibility.agent_id
                               AND e.day BETWEEN v_week AND v_week + 6 AND rr.status = 'completed'))
    INTO v_ok
  FROM public.agent_weekly_posting_eligibility WHERE week_start = v_week;
  r := r || jsonb_build_object('step', 'C collected above due only via finished plans; plan counts match groups', 'pass', v_ok);

  -- D ---------------------------------------------------------------------------
  SELECT agent_id INTO v_fail FROM public.agent_weekly_posting_eligibility
   WHERE week_start = v_week AND NOT passes
     -- not staff (can_view_staff_reports() can't be used here: with no JWT it answers true for everyone)
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = agent_id AND ur.enabled
                       AND ur.role::text IN ('manager','super_admin','coo','ceo','cto','cfo','cmo','crm','hr','rd','operations',
                                             'employee','tenant_ops','agent_ops','landlord_ops','partner_ops','financial_ops','access_admin'))
     AND NOT EXISTS (SELECT 1 FROM public.staff_permissions sp WHERE sp.user_id = agent_id AND sp.revoked_at IS NULL)
   LIMIT 1;
  SELECT agent_id INTO v_pass FROM public.agent_weekly_posting_eligibility
   WHERE week_start = v_week AND passes LIMIT 1;
  SELECT agent_id INTO v_other FROM public.agent_weekly_posting_eligibility
   WHERE week_start = v_week AND agent_id <> v_fail
     AND agent_id NOT IN (SELECT public.agent_wallet_network_ids(v_fail)) LIMIT 1;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_fail, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM public.get_agent_weekly_posting_eligibility(ARRAY[v_fail]);
  r := r || jsonb_build_object('step', 'D agent reads own result', 'pass', v_n = 1);
  BEGIN
    PERFORM * FROM public.get_agent_weekly_posting_eligibility(ARRAY[v_other]);
    r := r || jsonb_build_object('step', 'D agent refused another agent', 'pass', false);
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || jsonb_build_object('step', 'D agent refused another agent', 'pass', true);
  END;
  r := r || jsonb_build_object('step', 'D anon cannot execute',
           'pass', NOT has_function_privilege('anon', 'public.get_agent_weekly_posting_eligibility(uuid[])', 'EXECUTE'));
  PERFORM set_config('request.jwt.claims', '', true);

  -- E ---------------------------------------------------------------------------
  UPDATE public.agent_posting_rule_settings SET enforce_weekly = true;
  v_row := public._agent_weekly_posting_result(v_fail);
  r := r || jsonb_build_object('step', 'E failing agent resolves to a blocking row', 'pass', v_row.passes = false);
  v_row := public._agent_weekly_posting_result(v_pass);
  r := r || jsonb_build_object('step', 'E passing agent resolves to a passing row', 'pass', v_row.passes = true);

  RAISE EXCEPTION 'REPORT %', r;
END
$test$;

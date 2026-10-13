-- Rolled-back verification for 20261013160000_tenant_ops_weekly_amclock.sql
--
-- Run against the live database. Read-only: everything is rolled back, and the block ends in
-- RAISE EXCEPTION so the error text IS the report (a JSON list of steps with "pass").
--
--   A  access: a tenant_ops user can read both functions; a signed-out call and a user without a role are
--      refused; the helpers are not callable from the API and the new snapshot table is not readable
--   B  a plan whose landlord is unpaid is never active, paying, non-paying or 20+ days; the week's totals
--      are exactly the sums of the per-plan rows
--   C  the current week matches Agent Monitoring for the same day: the same plans, buckets and clock starts
--      as am_plan_clock / am_plan_arrears; active + landlord_not_paid = every live plan; paying is rebuilt
--      independently from the payment tables
--   D  frozen weeks are unchanged: the old snapshot table is byte-for-byte what it was before the migration
--      (md5 taken before applying), the history shows those weeks as recorded, nothing in the old table
--      or the new table before the first new week changes when the new functions run
--   E  the first week counted the new way is marked; pinning never writes an old or an open week
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_first date := public._tenant_ops_weekly_amclock_first_week();
  v_ws date; v_we date;
  v_staff uuid;
  v_plain uuid;
  v_ok boolean;
  v_json jsonb;
  v_raw record;
  n_a int; n_b int; n_c int; n_d int;
  v_md5_before text;
  v_md5_after text;
  v_rows_before int;
  v_rows_after int;
  -- md5 of every tenant_ops_weekly_metrics row before 2026-10-07, taken before the migration was applied
  c_frozen_md5 constant text := '70fd057d2d392305aa547ff0bed483a8';
BEGIN
  SELECT period_start, period_end INTO v_ws, v_we FROM public.tppo_period_bounds('week', v_today);
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'tenant_ops' AND enabled LIMIT 1;
  SELECT p.id INTO v_plain FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) LIMIT 1;

  -- A: access ----------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  v_ok := true;
  BEGIN
    PERFORM public.get_tenant_ops_weekly_performance_amclock();
    PERFORM 1 FROM public.get_tenant_ops_weekly_history_amclock(3);
  EXCEPTION WHEN OTHERS THEN v_ok := false;
  END;
  r := r || jsonb_build_object('step', 'A tenant_ops can read the performance and history functions', 'pass', v_ok);

  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false;
  BEGIN PERFORM public.get_tenant_ops_weekly_performance_amclock(); EXCEPTION WHEN OTHERS THEN v_ok := true; END;
  SELECT count(*) INTO n_a FROM public.get_tenant_ops_weekly_history_amclock(12);
  r := r || jsonb_build_object('step', 'A signed-out: performance refused, history empty', 'pass', v_ok AND n_a = 0);

  IF v_plain IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_plain, 'role', 'authenticated')::text, true);
    v_ok := false;
    BEGIN PERFORM public.get_tenant_ops_weekly_performance_amclock(); EXCEPTION WHEN OTHERS THEN v_ok := true; END;
    SELECT count(*) INTO n_a FROM public.get_tenant_ops_weekly_history_amclock(12);
    r := r || jsonb_build_object('step', 'A user without a role: performance refused, history empty', 'pass', v_ok AND n_a = 0);
  END IF;

  r := r || jsonb_build_object('step', 'A helpers and pin functions are not callable by authenticated or anon, the table is not readable',
    'pass', NOT has_function_privilege('authenticated', 'public._tenant_ops_weekly_metrics_raw_amclock(date,date)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public._tenant_ops_weekly_amclock_plans(date,date)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public.pin_tenant_ops_weekly_metrics_amclock(date)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.get_tenant_ops_weekly_performance_amclock(date)', 'EXECUTE')
        AND has_function_privilege('authenticated', 'public.get_tenant_ops_weekly_performance_amclock(date)', 'EXECUTE')
        AND has_function_privilege('authenticated', 'public.get_tenant_ops_weekly_history_amclock(integer)', 'EXECUTE')
        AND NOT has_table_privilege('authenticated', 'public.tenant_ops_weekly_metrics_amclock', 'SELECT'));

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);

  -- B: a plan whose landlord is unpaid is never counted -----------------------------
  CREATE TEMP TABLE _w ON COMMIT DROP AS SELECT * FROM public._tenant_ops_weekly_amclock_plans(v_ws, v_we);
  SELECT count(*) INTO n_a FROM _w WHERE landlord_not_paid AND (counted OR paying OR dormant);
  SELECT count(*) INTO n_b FROM _w WHERE bucket IN ('tenant_paying_no_landlord', 'awaiting_landlord') AND NOT landlord_not_paid;
  SELECT count(*) INTO n_c FROM _w WHERE landlord_not_paid;
  r := r || jsonb_build_object('step', 'B a plan with no counted landlord payout is never active, paying, non-paying or 20+ days',
    'pass', n_a = 0 AND n_b = 0 AND n_c > 0,
    'detail', jsonb_build_object('landlord_not_paid_plans', n_c, 'violations', n_a + n_b));

  SELECT * INTO v_raw FROM public._tenant_ops_weekly_metrics_raw_amclock(v_ws, v_we);
  r := r || jsonb_build_object('step', 'B the week totals are the sums of the per-plan rows',
    'pass', v_raw.total_active_tenants = (SELECT count(*) FROM _w WHERE counted)
        AND v_raw.paying_tenants = (SELECT count(*) FROM _w WHERE paying)
        AND v_raw.non_paying_tenants = (SELECT count(*) FROM _w WHERE counted AND NOT paying)
        AND v_raw.dormant_20_plus_count = (SELECT count(*) FROM _w WHERE dormant)
        AND v_raw.landlord_not_paid_count = (SELECT count(*) FROM _w WHERE landlord_not_paid)
        AND v_raw.non_paying_tenants = v_raw.total_active_tenants - v_raw.paying_tenants,
    'detail', to_jsonb(v_raw));

  -- C: same plans, buckets and starts as Agent Monitoring -------------------------------
  CREATE TEMP TABLE _am ON COMMIT DROP AS
    SELECT * FROM public.am_plan_clock(ARRAY(SELECT rent_request_id FROM _w));
  SELECT count(*) INTO n_a FROM _w w JOIN _am a ON a.rent_request_id = w.rent_request_id
   WHERE w.bucket IS DISTINCT FROM a.bucket OR w.clock_start IS DISTINCT FROM a.clock_start;
  r := r || jsonb_build_object('step', 'C every plan has the bucket and clock_start that am_plan_clock gives', 'pass', n_a = 0,
    'detail', jsonb_build_object('plans', (SELECT count(*) FROM _w), 'differences', n_a));

  SELECT count(*) INTO n_a FROM _am WHERE bucket IN ('counting', 'outstanding_balance') AND clock_start IS NOT NULL AND clock_start <= LEAST(v_we, v_today);
  SELECT count(*) INTO n_b FROM _am WHERE bucket IN ('tenant_paying_no_landlord', 'awaiting_landlord');
  r := r || jsonb_build_object('step', 'C active = counting + outstanding_balance plans started by today; landlord_not_paid = the two uncovered buckets; together every live plan',
    'pass', v_raw.total_active_tenants = n_a AND v_raw.landlord_not_paid_count = n_b
        AND n_a + n_b = (SELECT count(*) FROM _w) - (SELECT count(*) FROM _am WHERE bucket IN ('counting','outstanding_balance') AND (clock_start IS NULL OR clock_start > LEAST(v_we, v_today))),
    'detail', jsonb_build_object('active', v_raw.total_active_tenants, 'am_counted', n_a, 'landlord_not_paid', v_raw.landlord_not_paid_count, 'am_uncovered', n_b));

  -- am_plan_arrears sees the same bucket and start, and a landlord-unpaid plan has nothing expected, so no arrears
  CREATE TEMP TABLE _arr ON COMMIT DROP AS
    SELECT * FROM public.am_plan_arrears(ARRAY(SELECT rent_request_id FROM _w), v_today);
  SELECT count(*) INTO n_a FROM _w w JOIN _arr x ON x.rent_request_id = w.rent_request_id
   WHERE x.bucket IS DISTINCT FROM w.bucket OR x.clock_start IS DISTINCT FROM w.clock_start;
  SELECT count(*) INTO n_b FROM _w w JOIN _arr x ON x.rent_request_id = w.rent_request_id
   WHERE w.landlord_not_paid AND (x.arrears <> 0 OR x.expected_to_date <> 0);
  r := r || jsonb_build_object('step', 'C am_plan_arrears agrees on bucket and start, and a plan with no paid payout has no arrears',
    'pass', n_a = 0 AND n_b = 0, 'detail', jsonb_build_object('differences', n_a, 'unpaid_with_arrears', n_b));

  -- paying, rebuilt independently from the payment tables
  SELECT count(*) INTO n_a FROM _w w
   WHERE w.counted AND EXISTS (
     SELECT 1 FROM (
       SELECT (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS d FROM public.agent_collections ac
        WHERE ac.tenant_id = w.tenant_id AND ac.reversed_at IS NULL
       UNION ALL
       SELECT (rp.created_at AT TIME ZONE 'Africa/Kampala')::date FROM public.repayments rp WHERE rp.tenant_id = w.tenant_id
     ) p WHERE p.d BETWEEN v_ws AND v_we AND p.d >= w.clock_start);
  r := r || jsonb_build_object('step', 'C paying = counted plans paid in the week on or after their clock start (rebuilt from the payment tables)',
    'pass', n_a = v_raw.paying_tenants, 'detail', jsonb_build_object('rebuilt', n_a, 'function', v_raw.paying_tenants));

  -- the open week equals the current-week figures the page reads
  v_json := public.get_tenant_ops_weekly_performance_amclock();
  r := r || jsonb_build_object('step', 'C the page figures equal the live count while the week is open',
    'pass', (v_we < v_today)
         OR ((v_json->'current'->>'total_active_tenants')::int = v_raw.total_active_tenants
             AND (v_json->'current'->>'paying_tenants')::int = v_raw.paying_tenants
             AND (v_json->'current'->>'non_paying_tenants')::int = v_raw.non_paying_tenants
             AND (v_json->'current'->>'dormant_20_plus_count')::int = v_raw.dormant_20_plus_count
             AND (v_json->'current'->>'landlord_not_paid_count')::int = v_raw.landlord_not_paid_count));

  -- D: frozen weeks are unchanged ---------------------------------------------------
  SELECT md5(string_agg(t::text, '|' ORDER BY week_start)) INTO v_md5_after
    FROM public.tenant_ops_weekly_metrics t WHERE week_start < v_first;
  r := r || jsonb_build_object('step', 'D the old snapshot table before the first new week is byte-for-byte what it was before the migration',
    'pass', v_md5_after = c_frozen_md5, 'detail', jsonb_build_object('md5', v_md5_after, 'expected', c_frozen_md5));

  SELECT count(*) INTO n_a FROM (
    SELECT o.week_start, o.week_end, o.total_active_tenants, o.paying_tenants, o.non_paying_tenants, o.new_tenants_added,
           o.payment_rate_pct, o.captured_at, o.self_payment_tenants, o.dormant_20_plus_count
      FROM public.tenant_ops_weekly_metrics o WHERE o.week_start < v_first
    EXCEPT
    SELECT h.week_start, h.week_end, h.total_active_tenants, h.paying_tenants, h.non_paying_tenants, h.new_tenants_added,
           h.payment_rate_pct, h.captured_at, h.self_payment_tenants, h.dormant_20_plus_count
      FROM public.get_tenant_ops_weekly_history_amclock(104) h WHERE h.counting = 'old') q;
  SELECT count(*) INTO n_b FROM public.get_tenant_ops_weekly_history_amclock(104) h WHERE h.counting = 'old' AND h.week_start >= v_first;
  r := r || jsonb_build_object('step', 'D the history shows every earlier week exactly as recorded, marked old, with no landlord_not_paid figure',
    'pass', n_a = 0 AND n_b = 0
        AND (SELECT count(*) FROM public.get_tenant_ops_weekly_history_amclock(104) h WHERE h.counting = 'old')
          = (SELECT count(*) FROM public.tenant_ops_weekly_metrics WHERE week_start < v_first),
    'detail', jsonb_build_object('rows_not_matching', n_a));

  -- an old closed week read through the new performance function is the recorded row
  SELECT count(*) INTO n_a FROM public.tenant_ops_weekly_metrics WHERE week_start = DATE '2026-09-16';
  v_json := public.get_tenant_ops_weekly_performance_amclock(DATE '2026-09-20');
  r := r || jsonb_build_object('step', 'D an old closed week through the new function is the recorded row, marked old',
    'pass', n_a = 1
        AND v_json->>'counting' = 'old'
        AND (v_json->'current'->>'total_active_tenants')::int = (SELECT total_active_tenants FROM public.tenant_ops_weekly_metrics WHERE week_start = DATE '2026-09-16')
        AND (v_json->'current'->>'payment_rate_pct')::numeric = (SELECT payment_rate_pct FROM public.tenant_ops_weekly_metrics WHERE week_start = DATE '2026-09-16')
        AND (v_json->>'counting_changed_this_week')::boolean = false);

  -- running every new function writes nothing to either snapshot table
  SELECT count(*), md5(string_agg(t::text, '|' ORDER BY week_start)) INTO v_rows_before, v_md5_before FROM public.tenant_ops_weekly_metrics t;
  SELECT count(*) INTO n_c FROM public.tenant_ops_weekly_metrics_amclock;
  PERFORM public.get_tenant_ops_weekly_performance_amclock();
  PERFORM public.get_tenant_ops_weekly_performance_amclock(v_today - 7);
  PERFORM 1 FROM public.get_tenant_ops_weekly_history_amclock(12);
  PERFORM public.pin_tenant_ops_weekly_metrics_amclock(v_today - 21);
  PERFORM public.pin_tenant_ops_weekly_metrics_amclock_catchup(8);
  SELECT count(*), md5(string_agg(t::text, '|' ORDER BY week_start)) INTO v_rows_after, v_md5_after FROM public.tenant_ops_weekly_metrics t;
  SELECT count(*) INTO n_d FROM public.tenant_ops_weekly_metrics_amclock;
  r := r || jsonb_build_object('step', 'D the new functions never write the old snapshot table, and write no week before the first new week',
    'pass', v_rows_before = v_rows_after AND v_md5_before = v_md5_after
        AND NOT EXISTS (SELECT 1 FROM public.tenant_ops_weekly_metrics_amclock WHERE week_start < v_first)
        AND n_d >= n_c);

  -- E: the first new week is marked; pinning guards ----------------------------------
  r := r || jsonb_build_object('step', 'E the first week counted the new way is marked on the page figures',
    'pass', (public.get_tenant_ops_weekly_performance_amclock(v_first)->>'counting_changed_this_week')::boolean
        AND NOT (public.get_tenant_ops_weekly_performance_amclock(v_first + 7)->>'counting_changed_this_week')::boolean
        AND public.get_tenant_ops_weekly_performance_amclock(v_first)->>'counting' = 'amclock'
        AND public.get_tenant_ops_weekly_performance_amclock(v_first)->'previous'->>'counting' = 'old');

  DELETE FROM public.tenant_ops_weekly_metrics_amclock WHERE week_start = v_first;
  INSERT INTO public.tenant_ops_weekly_metrics_amclock
    (week_start, week_end, total_active_tenants, paying_tenants, non_paying_tenants, new_tenants_added,
     payment_rate_pct, self_payment_tenants, dormant_20_plus_count, landlord_not_paid_count)
  VALUES (v_first, v_first + 6, 10, 4, 6, 1, 40.0, 0, 2, 3);
  SELECT count(*) INTO n_a FROM public.get_tenant_ops_weekly_history_amclock(104) h WHERE h.counting_changed;
  SELECT count(*) INTO n_b FROM public.get_tenant_ops_weekly_history_amclock(104) h
   WHERE h.counting_changed AND h.week_start = v_first AND h.counting = 'amclock' AND h.landlord_not_paid_count = 3;
  r := r || jsonb_build_object('step', 'E the history flags exactly the first new week once it is frozen',
    'pass', n_a = 1 AND n_b = 1);

  r := r || jsonb_build_object('step', 'E pinning writes nothing for an old week or an open week',
    'pass', public.pin_tenant_ops_weekly_metrics_amclock(v_first - 7) = 0
        AND public.pin_tenant_ops_weekly_metrics_amclock(v_today) = 0
        AND NOT EXISTS (SELECT 1 FROM public.tenant_ops_weekly_metrics_amclock WHERE week_start < v_first));

  RAISE EXCEPTION 'ROLLED BACK REPORT: %', jsonb_pretty(r);
END
$test$;

-- Read-only test for 20261103100000_payout_grade_through_yesterday.sql. Run on STAGING (never edit data). Run on a Tuesday and on a Thursday.
-- Raises an exception on failure; prints NOTICEs with what was checked.
DO $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_cur date := public._agent_rule_week_start((now() AT TIME ZONE 'Africa/Kampala')::date);
  v_through date := ((now() AT TIME ZONE 'Africa/Kampala')::date) - 1;
  a record; r record; v_exp numeric; v_got numeric; v_n int := 0; v_bad int := 0;
  v_end_label text;
BEGIN
  -- 1. Grants: anon and authenticated must not execute, service_role must.
  IF has_function_privilege('anon', 'public.agent_payout_weekly_performance(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute agent_payout_weekly_performance'; END IF;
  IF has_function_privilege('authenticated', 'public.agent_payout_weekly_performance(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute agent_payout_weekly_performance'; END IF;
  IF NOT has_function_privilege('service_role', 'public.agent_payout_weekly_performance(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute agent_payout_weekly_performance'; END IF;

  -- 2. Expected / collected match plan lines through yesterday, for up to 20 agents that have plans.
  FOR a IN
    SELECT DISTINCT rr.agent_id AS agent_id FROM public.rent_requests rr
     WHERE rr.agent_id IS NOT NULL AND rr.status IN ('repaying', 'funded') LIMIT 20
  LOOP
    SELECT * INTO r FROM public.agent_payout_weekly_performance(a.agent_id);
    v_n := v_n + 1;
    IF v_today = v_cur THEN
      -- Thursday: the week that just ended.
      IF r.basis <> 'last_week' THEN
        RAISE EXCEPTION 'Thursday: agent % basis is %, expected last_week', a.agent_id, r.basis; END IF;
      IF r.week_start <> v_cur - 7 THEN
        RAISE EXCEPTION 'Thursday: agent % week_start % <> %', a.agent_id, r.week_start, v_cur - 7; END IF;
    ELSE
      IF r.basis <> 'week_so_far' THEN
        RAISE EXCEPTION 'agent % basis is %, expected week_so_far', a.agent_id, r.basis; END IF;
      SELECT COALESCE(sum(l.due), 0), COALESCE(sum(l.collected), 0) INTO v_exp, v_got
        FROM public._agent_weekly_plan_lines(a.agent_id, v_cur, v_through) l;
      IF r.expected IS DISTINCT FROM v_exp OR r.collected IS DISTINCT FROM v_got THEN
        v_bad := v_bad + 1;
        RAISE WARNING 'MISMATCH agent %: function expected/collected %/%, lines through % = %/%',
          a.agent_id, r.expected, r.collected, v_through, v_exp, v_got;
      END IF;
      -- Reason text must end the window at yesterday (only present when something was billed).
      IF r.book <> 'none' THEN
        v_end_label := ' to ' || to_char(v_through, 'FMDD Mon') || ')';
        IF position(v_end_label IN r.reason) = 0 THEN
          v_bad := v_bad + 1;
          RAISE WARNING 'agent %: reason does not end at yesterday (%): %', a.agent_id, v_through, left(r.reason, 120);
        END IF;
      END IF;
    END IF;
  END LOOP;

  IF v_bad > 0 THEN RAISE EXCEPTION 'payout_grade_through_yesterday: % failures across % agents', v_bad, v_n; END IF;
  IF v_n = 0 THEN RAISE WARNING 'No agents with plans found, nothing compared (grants were checked).'; END IF;
  RAISE NOTICE 'payout_grade_through_yesterday OK: % agents checked, today=%, through=%, mode=%',
    v_n, v_today, v_through, CASE WHEN v_today = v_cur THEN 'thursday/last_week' ELSE 'week_so_far' END;
END $$;

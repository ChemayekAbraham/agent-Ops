-- Rolled-back verification for 20261027150000_agent_reports_match_weekly_rule.sql
--
-- Run against the live database. The block ends in RAISE EXCEPTION, so nothing is kept; the error text
-- IS the report.
--
--   A  every agent: the Weekly Performance page's week so far = the shared expected source
--   B  every agent: the "this week" card (agent_expected_week, rule week so far) = the shared source
--   C  every agent: the weekly rule's saved result = the shared source over the judged week
--   D  the daily view's expected_daily includes today's normal days (Shafeeq: view = shared source today)
--   E  get_my_expected_days: an agent gets their own days (= shared source), another agent is refused
--   F  the view's helper called directly by a non-staff agent returns only that agent's rows;
--      the fast impl can't be called by signed-in users at all
BEGIN;
-- F runs at top level, the way the browser reaches the view's helper (a call from inside the DO block
-- below would count as an internal call and return everything, by design).
CREATE TEMP TABLE _f_agent AS
  SELECT e.agent_id AS id FROM public.agent_expected_day_plans e
   WHERE e.day = (now() AT TIME ZONE 'Africa/Kampala')::date
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = e.agent_id AND ur.enabled
                       AND ur.role::text IN ('manager','super_admin','coo','ceo','cto','cfo','cmo','crm','hr','rd','operations',
                                             'employee','tenant_ops','agent_ops','landlord_ops','partner_ops','financial_ops','access_admin'))
     AND NOT EXISTS (SELECT 1 FROM public.staff_permissions sp WHERE sp.user_id = e.agent_id AND sp.revoked_at IS NULL)
   LIMIT 1;
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT id FROM _f_agent), 'role', 'authenticated')::text, true);
CREATE TEMP TABLE _f_rows AS
  SELECT x.agent_id FROM public._agent_expected_effective(NULL, (now() AT TIME ZONE 'Africa/Kampala')::date, (now() AT TIME ZONE 'Africa/Kampala')::date) x;
SELECT set_config('request.jwt.claims', '', true);

DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_cur   date := public._agent_rule_week_start((now() AT TIME ZONE 'Africa/Kampala')::date);
  v_week  date := public._agent_rule_judged_week_start();
  v_shafeeq uuid := '98b7b07a-3d03-4600-b94e-cda122bbe4ae';
  v_agent uuid;
  v_other uuid;
  v_n int;
  v_a numeric;
  v_b numeric;
  v_ok boolean;
BEGIN
  -- A
  SELECT count(*) INTO v_n
  FROM (SELECT x.agent_id, sum(x.expected_ugx) s
          FROM public._agent_expected_effective__impl(NULL, v_cur, v_today) x GROUP BY 1) e
  WHERE e.s <> (SELECT COALESCE(sum(l.due), 0) FROM public._agent_weekly_plan_lines(e.agent_id, v_cur, v_today) l);
  r := r || jsonb_build_object('step', 'A page week so far = shared source (all agents)', 'pass', v_n = 0, 'detail', v_n || ' mismatches');

  -- B
  SELECT count(*) INTO v_n
  FROM (SELECT x.agent_id, sum(x.expected_ugx) s
          FROM public._agent_expected_effective__impl(NULL, v_cur, v_today) x GROUP BY 1) e
  WHERE e.s <> (SELECT expected_week FROM public.agent_expected_week__impl(ARRAY[e.agent_id], (v_today - v_cur + 1)::int));
  r := r || jsonb_build_object('step', 'B this-week card = shared source (all agents)', 'pass', v_n = 0, 'detail', v_n || ' mismatches');

  -- C
  SELECT count(*) INTO v_n
  FROM public.agent_weekly_posting_eligibility s
  WHERE s.week_start = v_week
    AND s.in_window_due + s.expired_due <> (SELECT COALESCE(sum(x.expected_ugx), 0)
                                              FROM public._agent_expected_effective__impl(ARRAY[s.agent_id], v_week, v_week + 6) x
                                             WHERE x.agent_id = s.agent_id);
  r := r || jsonb_build_object('step', 'C saved weekly result = shared source over the judged week', 'pass', v_n = 0, 'detail', v_n || ' mismatches');

  -- D
  SELECT v.expected_daily INTO v_a FROM public.v_agent_daily_eligibility v WHERE v.agent_id = v_shafeeq;
  SELECT COALESCE(sum(x.expected_ugx), 0) INTO v_b
    FROM public._agent_expected_effective__impl(ARRAY[v_shafeeq], v_today, v_today) x WHERE x.agent_id = v_shafeeq;
  r := r || jsonb_build_object('step', 'D daily view today = shared source today (Shafeeq)', 'pass', v_a = v_b,
                               'detail', jsonb_build_object('view', v_a, 'shared', v_b));

  -- E / F as a non-staff agent with bills this week
  SELECT e.agent_id INTO v_agent FROM public.agent_expected_day_plans e
   WHERE e.day = v_today
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = e.agent_id AND ur.enabled
                       AND ur.role::text IN ('manager','super_admin','coo','ceo','cto','cfo','cmo','crm','hr','rd','operations',
                                             'employee','tenant_ops','agent_ops','landlord_ops','partner_ops','financial_ops','access_admin'))
     AND NOT EXISTS (SELECT 1 FROM public.staff_permissions sp WHERE sp.user_id = e.agent_id AND sp.revoked_at IS NULL)
   LIMIT 1;
  SELECT e.agent_id INTO v_other FROM public.agent_expected_day_plans e
   WHERE e.day = v_today AND e.agent_id <> v_agent
     AND e.agent_id NOT IN (SELECT public.agent_wallet_network_ids(v_agent)) LIMIT 1;
  SELECT COALESCE(sum(x.expected_ugx), 0) INTO v_b
    FROM public._agent_expected_effective__impl(ARRAY[v_agent], v_cur, v_today) x WHERE x.agent_id = v_agent;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
  SELECT COALESCE(sum(expected_ugx), 0) INTO v_a FROM public.get_my_expected_days(v_cur, v_today);
  r := r || jsonb_build_object('step', 'E agent reads own expected days (= shared source)', 'pass', v_a = v_b);
  BEGIN
    PERFORM * FROM public.get_my_expected_days(v_cur, v_today, v_other);
    r := r || jsonb_build_object('step', 'E another agent''s days refused', 'pass', false);
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || jsonb_build_object('step', 'E another agent''s days refused', 'pass', true);
  END;

  PERFORM set_config('request.jwt.claims', '', true);
  SELECT count(*), bool_and(f.agent_id = a.id OR f.agent_id IN (SELECT public.agent_wallet_network_ids(a.id))) INTO v_n, v_ok
    FROM _f_rows f CROSS JOIN _f_agent a;
  r := r || jsonb_build_object('step', 'F direct helper call (top level, as agent) returns only own/network rows',
                               'pass', COALESCE(v_ok, true), 'detail', v_n || ' rows');

  r := r || jsonb_build_object('step', 'F fast impl closed to signed-in users and anon',
           'pass', NOT has_function_privilege('authenticated', 'public._agent_expected_effective__impl(uuid[],date,date)', 'EXECUTE')
               AND NOT has_function_privilege('anon', 'public._agent_expected_effective(uuid[],date,date)', 'EXECUTE')
               AND NOT has_function_privilege('anon', 'public.get_my_expected_days(date,date,uuid)', 'EXECUTE'));

  RAISE EXCEPTION 'REPORT %', r;
END
$test$;

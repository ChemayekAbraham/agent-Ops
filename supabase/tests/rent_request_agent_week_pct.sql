-- Tests for 20261026170000_rent_request_agent_week_pct.sql (rent_request_agent_week_pct).
-- Runs the migration's function in one transaction and always rolls back (the last statement raises with the report); nothing is kept.
-- Usage: (echo 'BEGIN;'; cat supabase/migrations/20261026170000_rent_request_agent_week_pct.sql; cat supabase/tests/rent_request_agent_week_pct.sql) | supabase db query --linked
-- "ROLLED BACK REPORT: N passed of N | failing: none" is success. Every figure is compared with what the agent's own screen reads
-- (get_my_weekly_performance, run as a staff reader) for EVERY agent returned, so the desks and the agent can never disagree.
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_desk uuid; v_mgr uuid; v_plain uuid; v_scm uuid;
  v_ids uuid[]; v_n int; v_bad int := 0; v_checked int := 0; v_ms numeric;
  v_t0 timestamptz;
  ar record; w jsonb; cw jsonb; jw jsonb;
  v_agents uuid[];
  v_one uuid; v_other uuid;
BEGIN
  -- A. properties and grants
  r := r || jsonb_build_object('step', 'A SECURITY DEFINER, STABLE, search_path = public',
    'pass', (SELECT p.prosecdef AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=public']
               FROM pg_proc p WHERE p.oid = 'public.rent_request_agent_week_pct(uuid[])'::regprocedure));
  r := r || jsonb_build_object('step', 'A authenticated can execute; anon, service_role and PUBLIC cannot',
    'pass', (SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                    AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)
               FROM pg_proc p WHERE p.oid = 'public.rent_request_agent_week_pct(uuid[])'::regprocedure));
  r := r || jsonb_build_object('step', 'A read-only: no INSERT / UPDATE / DELETE in the body',
    'pass', (SELECT p.prosrc !~* '\m(insert\s+into|update\s+\w+\s+set|delete\s+from)' FROM pg_proc p
              WHERE p.oid = 'public.rent_request_agent_week_pct(uuid[])'::regprocedure));

  SELECT ur.user_id INTO v_desk FROM public.user_roles ur WHERE ur.role = 'tenant_ops'::public.app_role AND ur.enabled ORDER BY ur.user_id LIMIT 1;
  SELECT ur.user_id INTO v_mgr FROM public.user_roles ur WHERE ur.role = 'manager'::public.app_role AND ur.enabled ORDER BY ur.user_id LIMIT 1;
  SELECT p.id INTO v_plain FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) ORDER BY p.id LIMIT 1;
  SELECT array_agg(id) INTO v_ids FROM (
    SELECT id FROM public.rent_requests WHERE status IN ('pending','agent_verified','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','partner_ops_approved','coo_approved','funded','repaying') AND agent_id IS NOT NULL ORDER BY created_at DESC LIMIT 3000) s;

  -- B. the desk gate
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_desk, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_t0 := clock_timestamp();
    SELECT count(*) INTO v_n FROM public.rent_request_agent_week_pct(v_ids);
    v_ms := extract(epoch FROM clock_timestamp() - v_t0) * 1000;
    RESET ROLE;
    r := r || jsonb_build_object('step', 'B a Tenant Ops user gets one row per registering agent', 'pass', v_n > 0 AND v_n = (SELECT count(DISTINCT agent_id) FROM public.rent_requests WHERE id = ANY (v_ids)),
      'detail', format('%s agents from %s requests in %s ms', v_n, cardinality(v_ids), round(v_ms)));
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B a Tenant Ops user gets one row per registering agent', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
  END;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_plain, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM 1 FROM public.rent_request_agent_week_pct(v_ids);
    RESET ROLE;
    r := r || jsonb_build_object('step', 'B a user with no role is refused (42501)', 'pass', false);
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B a user with no role is refused (42501)', 'pass', SQLSTATE = '42501'); END IF;
  END;
  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    SET LOCAL ROLE authenticated;
    PERFORM 1 FROM public.rent_request_agent_week_pct(v_ids);
    RESET ROLE;
    r := r || jsonb_build_object('step', 'B signed out is refused (42501)', 'pass', false);
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B signed out is refused (42501)', 'pass', SQLSTATE = '42501'); END IF;
  END;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_desk, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM 1 FROM public.rent_request_agent_week_pct(ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 5001)));
    RESET ROLE;
    r := r || jsonb_build_object('step', 'B more than 5000 ids is refused (22023)', 'pass', false);
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B more than 5000 ids is refused (22023)', 'pass', SQLSTATE = '22023'); END IF;
  END;

  -- service centre manager: own requests only
  SELECT service_center_manager_id, (array_agg(id))[1] INTO v_scm, v_one FROM public.rent_requests
   WHERE service_center_manager_id IS NOT NULL AND agent_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = service_center_manager_id AND ur.enabled AND ur.role::text IN ('manager','super_admin','coo','ceo','cto','cfo','operations','tenant_ops','agent_ops','financial_ops','landlord_ops','partner_ops'))
   GROUP BY service_center_manager_id ORDER BY count(*) DESC LIMIT 1;
  IF v_scm IS NOT NULL THEN
    SELECT id INTO v_other FROM public.rent_requests WHERE service_center_manager_id IS DISTINCT FROM v_scm AND agent_id IS NOT NULL LIMIT 1;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_scm, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      SELECT count(*) INTO v_n FROM public.rent_request_agent_week_pct(ARRAY[v_one]);
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B a service centre manager can read their own request', 'pass', v_n = 1);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B a service centre manager can read their own request', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_scm, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      PERFORM 1 FROM public.rent_request_agent_week_pct(ARRAY[v_one, v_other]);
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B a service centre manager is refused someone else''s request (42501)', 'pass', false);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B a service centre manager is refused someone else''s request (42501)', 'pass', SQLSTATE = '42501'); END IF;
    END;
  END IF;

  -- C. every agent equals what the agent's own screen reads
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_desk, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  CREATE TEMP TABLE _wk ON COMMIT DROP AS SELECT * FROM public.rent_request_agent_week_pct(v_ids);
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  FOR ar IN SELECT * FROM _wk LOOP
    w := public.get_my_weekly_performance(1, ar.agent_id);
    cw := w -> 'current_week';
    jw := (w -> 'weeks') -> 0;
    v_checked := v_checked + 1;
    IF NOT (
      ar.week_start = (cw ->> 'week_start')::date AND ar.week_end = (cw ->> 'week_end')::date AND ar.days_left = (cw ->> 'days_left')::int
      AND ar.book = cw ->> 'book'
      AND ar.in_window_plans = (cw ->> 'in_window_plans')::int AND ar.in_window_collected = (cw ->> 'in_window_collected')::numeric
      AND ar.in_window_due_so_far = (cw ->> 'in_window_due_so_far')::numeric AND ar.in_window_projected_due = (cw ->> 'in_window_projected_due')::numeric
      AND ar.in_window_required_pct IS NOT DISTINCT FROM (cw ->> 'in_window_required_pct')::numeric
      AND ar.expired_plans = (cw ->> 'expired_plans')::int AND ar.expired_collected = (cw ->> 'expired_collected')::numeric
      AND ar.expired_due_so_far = (cw ->> 'expired_due_so_far')::numeric AND ar.expired_projected_due = (cw ->> 'expired_projected_due')::numeric
      AND ar.expired_required_pct IS NOT DISTINCT FROM (cw ->> 'expired_required_pct')::numeric
      AND ar.last_week_start = (jw ->> 'week_start')::date AND ar.last_book IS NOT DISTINCT FROM CASE WHEN jw ->> 'book' = 'none' AND ar.last_book IS NULL THEN NULL ELSE jw ->> 'book' END
      AND ar.last_in_window_pct IS NOT DISTINCT FROM (jw ->> 'in_window_pct')::numeric
      AND ar.last_expired_pct IS NOT DISTINCT FROM (jw ->> 'expired_pct')::numeric
    ) THEN v_bad := v_bad + 1; END IF;
  END LOOP;
  RESET ROLE;
  r := r || jsonb_build_object('step', 'C every agent row equals get_my_weekly_performance for that agent (this week and the judged week)', 'pass', v_checked > 0 AND v_bad = 0,
    'detail', format('%s agents checked, %s different', v_checked, v_bad));
  r := r || jsonb_build_object('step', 'C the week is the Thursday-Wednesday week that contains today (Kampala)',
    'pass', (SELECT bool_and(extract(isodow FROM week_start) = 4 AND week_end = week_start + 6 AND (now() AT TIME ZONE 'Africa/Kampala')::date BETWEEN week_start AND week_end) FROM _wk));
  r := r || jsonb_build_object('step', 'C the judged week is the previous Thursday-Wednesday week',
    'pass', (SELECT bool_and(extract(isodow FROM last_week_start) = 4 AND last_week_start = week_start - 7) FROM _wk));
  r := r || jsonb_build_object('step', 'C collected never exceeds the projected full-week due, per group',
    'pass', NOT EXISTS (SELECT 1 FROM _wk WHERE in_window_collected > in_window_projected_due OR expired_collected > expired_projected_due));
  r := r || jsonb_build_object('step', 'C an agent with no Rent Plan billed this week has book none and no required %',
    'pass', NOT EXISTS (SELECT 1 FROM _wk WHERE book = 'none' AND (in_window_required_pct IS NOT NULL OR expired_required_pct IS NOT NULL)));
  r := r || jsonb_build_object('step', 'C the registering agent is the one used: every returned agent registered one of the requests',
    'pass', NOT EXISTS (SELECT 1 FROM _wk x WHERE NOT EXISTS (SELECT 1 FROM public.rent_requests q WHERE q.id = ANY (v_ids) AND q.agent_id = x.agent_id)));

  RAISE EXCEPTION 'ROLLED BACK REPORT: % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none')
    || ' | ' || COALESCE((SELECT string_agg(e->>'step' || ' = ' || (e->>'detail'), '; ') FROM jsonb_array_elements(r) e WHERE e->>'detail' IS NOT NULL AND (e->>'pass') = 'true'), '');
END
$test$;

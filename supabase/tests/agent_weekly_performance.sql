-- Rolled-back verification for 20261023140000_agent_weekly_performance.sql
--
-- Run against the live database. The block ends in RAISE EXCEPTION so the error text IS the report.
--
--   A  per-plan lines for the judged week add up to the saved weekly result, for every agent
--   B  an agent reading itself gets the judged week equal to the saved result, and 6 weeks
--   C  the current week: collected never above billed, projection never below billed so far
--   D  access: another agent's page is refused; anon cannot execute
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_week date := public._agent_rule_judged_week_start();
  v_ok boolean;
  v_agent uuid;
  v_other uuid;
  v_doc jsonb;
  v_saved public.agent_weekly_posting_eligibility;
BEGIN
  -- A -------------------------------------------------------------------------
  SELECT bool_and(s.in_window_due = x.in_due AND s.in_window_collected = x.in_got
                  AND s.expired_due = x.ex_due AND s.expired_collected = x.ex_got)
    INTO v_ok
  FROM public.agent_weekly_posting_eligibility s
  CROSS JOIN LATERAL (
    SELECT COALESCE(sum(due) FILTER (WHERE NOT expired), 0) in_due,
           COALESCE(sum(collected) FILTER (WHERE NOT expired), 0) in_got,
           COALESCE(sum(due) FILTER (WHERE expired), 0) ex_due,
           COALESCE(sum(collected) FILTER (WHERE expired), 0) ex_got
    FROM public._agent_weekly_plan_lines(s.agent_id, s.week_start, s.week_end)
  ) x
  WHERE s.week_start = v_week;
  r := r || jsonb_build_object('step', 'A plan lines add up to the saved result (all agents)', 'pass', v_ok);

  -- B -------------------------------------------------------------------------
  SELECT agent_id INTO v_agent FROM public.agent_weekly_posting_eligibility
   WHERE week_start = v_week AND book = 'mixed'
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = agent_id AND ur.enabled
                       AND ur.role::text IN ('manager','super_admin','coo','ceo','cto','cfo','cmo','crm','hr','rd','operations',
                                             'employee','tenant_ops','agent_ops','landlord_ops','partner_ops','financial_ops','access_admin'))
     AND NOT EXISTS (SELECT 1 FROM public.staff_permissions sp WHERE sp.user_id = agent_id AND sp.revoked_at IS NULL)
   LIMIT 1;
  SELECT agent_id INTO v_other FROM public.agent_weekly_posting_eligibility
   WHERE week_start = v_week AND agent_id <> v_agent
     AND agent_id NOT IN (SELECT public.agent_wallet_network_ids(v_agent)) LIMIT 1;
  SELECT * INTO v_saved FROM public.agent_weekly_posting_eligibility WHERE agent_id = v_agent AND week_start = v_week;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
  v_doc := public.get_my_weekly_performance(6, NULL);
  r := r || jsonb_build_object('step', 'B six weeks returned, first is the judged week',
           'pass', jsonb_array_length(v_doc->'weeks') = 6
               AND (v_doc->'weeks'->0->>'week_start')::date = v_week
               AND (v_doc->'weeks'->0->>'is_judged')::boolean);
  r := r || jsonb_build_object('step', 'B judged week equals the saved result',
           'pass', (v_doc->'weeks'->0->>'in_window_due')::numeric = v_saved.in_window_due
               AND (v_doc->'weeks'->0->>'expired_collected')::numeric = v_saved.expired_collected
               AND (v_doc->'weeks'->0->>'passes')::boolean = v_saved.passes);

  -- C -------------------------------------------------------------------------
  r := r || jsonb_build_object('step', 'C current week: collected <= billed <= projected',
           'pass', (v_doc->'current_week'->>'in_window_collected')::numeric <= (v_doc->'current_week'->>'in_window_due_so_far')::numeric
               AND (v_doc->'current_week'->>'in_window_due_so_far')::numeric <= (v_doc->'current_week'->>'in_window_projected_due')::numeric
               AND (v_doc->'current_week'->>'expired_collected')::numeric <= (v_doc->'current_week'->>'expired_due_so_far')::numeric
               AND (v_doc->'current_week'->>'expired_due_so_far')::numeric <= (v_doc->'current_week'->>'expired_projected_due')::numeric,
           'detail', v_doc->'current_week');
  SELECT bool_and((p->>'collected')::numeric <= (p->>'due_so_far')::numeric) INTO v_ok
    FROM jsonb_array_elements(v_doc->'plans') p;
  r := r || jsonb_build_object('step', 'C every plan line capped', 'pass', COALESCE(v_ok, true),
           'detail', jsonb_array_length(v_doc->'plans'));

  -- D -------------------------------------------------------------------------
  BEGIN
    PERFORM public.get_my_weekly_performance(6, v_other);
    r := r || jsonb_build_object('step', 'D another agent refused', 'pass', false);
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || jsonb_build_object('step', 'D another agent refused', 'pass', true);
  END;
  r := r || jsonb_build_object('step', 'D anon cannot execute',
           'pass', NOT has_function_privilege('anon', 'public.get_my_weekly_performance(integer,uuid)', 'EXECUTE'));

  RAISE EXCEPTION 'REPORT %', r;
END
$test$;

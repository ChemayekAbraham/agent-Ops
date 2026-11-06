-- Checks for 20261029190000 (weekly performance projection by schedule). Read-only: ends in RAISE EXCEPTION so nothing is kept.
-- A  every agent billed this week: projected >= billed so far, in both groups
-- B  agents with no weekly/monthly plan: projection identical to the old formula (due + today's bill x days left)
-- C  a weekly plan billed today counts once, not once per day left
-- D  a weekly plan billed later this week is projected at its instalment
-- E  plan counts include plans only projected (not billed yet) and never plans with nothing due
DO $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_cur date := public._agent_rule_week_start(v_today);
  v_left int := (public._agent_rule_week_start(v_today) + 6) - v_today;
  a record; j jsonb; c jsonb;
  n_agents int := 0; n_same int := 0; n_weekly int := 0;
  old_in numeric; old_ex numeric; has_nd boolean;
  r record; v_wk_today int := 0; v_wk_later int := 0;
BEGIN
  FOR a IN SELECT DISTINCT e.agent_id FROM public._agent_expected_effective__impl(NULL, v_cur, v_today) e WHERE e.agent_id IS NOT NULL LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a.agent_id, 'role', 'authenticated')::text, true);
    j := public.get_my_weekly_performance(1, NULL);
    c := j->'current_week';
    n_agents := n_agents + 1;

    IF (c->>'in_window_projected_due')::numeric < (c->>'in_window_due_so_far')::numeric
       OR (c->>'expired_projected_due')::numeric < (c->>'expired_due_so_far')::numeric THEN
      RAISE EXCEPTION 'A failed for %: %', a.agent_id, c;
    END IF;

    SELECT COALESCE(sum(l.due + l.last_day_due * v_left) FILTER (WHERE NOT l.expired), 0),
           COALESCE(sum(l.due + l.last_day_due * v_left) FILTER (WHERE l.expired), 0)
      INTO old_in, old_ex
      FROM public._agent_weekly_plan_lines(a.agent_id, v_cur, v_today) l;
    has_nd := EXISTS (SELECT 1 FROM public.rent_requests rr
                       WHERE COALESCE(rr.assigned_agent_id, rr.agent_id) = a.agent_id AND rr.status = 'repaying'
                         AND lower(COALESCE(rr.repayment_frequency, 'daily')) IN ('weekly', 'monthly'));
    IF NOT has_nd THEN
      IF old_in <> (c->>'in_window_projected_due')::numeric OR old_ex <> (c->>'expired_projected_due')::numeric THEN
        RAISE EXCEPTION 'B failed for %: old % / %, new %', a.agent_id, old_in, old_ex, c;
      END IF;
      n_same := n_same + 1;
    ELSE
      n_weekly := n_weekly + 1;
    END IF;

    IF (c->>'in_window_plans')::int + (c->>'expired_plans')::int
       < (SELECT count(*) FROM public._agent_weekly_plan_lines(a.agent_id, v_cur, v_today)) THEN
      RAISE EXCEPTION 'E failed for %: %', a.agent_id, c;
    END IF;
  END LOOP;

  -- C and D on a concrete agent: each weekly plan contributes exactly (billed so far + its remaining instalments).
  FOR r IN
    SELECT COALESCE(rr.assigned_agent_id, rr.agent_id) AS aid, rr.id,
           COALESCE((SELECT sum(e.expected_ugx) FROM public._agent_expected_effective__impl(ARRAY[COALESCE(rr.assigned_agent_id, rr.agent_id)], v_cur, v_today) e WHERE e.rent_request_id = rr.id), 0) AS so_far,
           COALESCE((SELECT sum(g.amount) FROM public.rent_plan_schedule_days(v_today + 1, v_cur + 6) g WHERE g.rent_request_id = rr.id AND g.due_on >= public.rent_plan_billable_from(rr.id)), 0) AS later
    FROM public.rent_requests rr
    WHERE rr.status = 'repaying' AND lower(rr.repayment_frequency) = 'weekly'
      AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
  LOOP
    IF r.so_far > 0 AND r.later = 0 THEN v_wk_today := v_wk_today + 1; END IF;
    IF r.so_far = 0 AND r.later > 0 THEN v_wk_later := v_wk_later + 1; END IF;
  END LOOP;

  -- C/D concretely: the agent with the most weekly plans; new projection = old for daily plans + weekly plans' own amounts.
  SELECT x.aid INTO r FROM (
    SELECT COALESCE(rr.assigned_agent_id, rr.agent_id) AS aid, count(*) n FROM public.rent_requests rr
    WHERE rr.status = 'repaying' AND lower(rr.repayment_frequency) = 'weekly' GROUP BY 1 ORDER BY 2 DESC LIMIT 1) x;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', r.aid, 'role', 'authenticated')::text, true);
  c := public.get_my_weekly_performance(1, NULL)->'current_week';
  DECLARE expect numeric;
  BEGIN
    SELECT COALESCE(sum(CASE WHEN lower(COALESCE(rr.repayment_frequency,'daily')) IN ('weekly','monthly') THEN l.due ELSE l.due + l.last_day_due * v_left END), 0)
         + COALESCE((SELECT sum(g.amount) FROM public.rent_plan_schedule_days(v_today + 1, v_cur + 6) g
                      JOIN public.rent_requests r2 ON r2.id = g.rent_request_id
                     WHERE COALESCE(r2.assigned_agent_id, r2.agent_id) = r.aid AND r2.status = 'repaying' AND v_left > 0
                       AND lower(COALESCE(r2.repayment_frequency,'daily')) IN ('weekly','monthly')
                       AND g.due_on >= public.rent_plan_billable_from(r2.id)), 0)
      INTO expect
      FROM public._agent_weekly_plan_lines(r.aid, v_cur, v_today) l JOIN public.rent_requests rr ON rr.id = l.rent_request_id;
    IF expect <> (c->>'in_window_projected_due')::numeric + (c->>'expired_projected_due')::numeric THEN
      RAISE EXCEPTION 'C/D failed for %: expected % got %', r.aid, expect, c;
    END IF;
  END;

  RAISE EXCEPTION 'REPORT all checks passed: % agents billed this week, % unchanged (daily only), % with weekly/monthly plans; weekly plans billed so far only: %, billed later only: %',
    n_agents, n_same, n_weekly, v_wk_today, v_wk_later;
END $$;

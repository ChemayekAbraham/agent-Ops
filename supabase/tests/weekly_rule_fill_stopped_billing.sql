-- Rolled-back verification for 20261027100000_weekly_rule_fill_stopped_billing.sql
--
-- Run against the live database after the migration. The block ends in RAISE EXCEPTION, so nothing is
-- kept; the error text IS the report.
--
--   A  Bayube Richard (Shafeeq's expired tenant, last billed 23 Oct) counts as a normal week:
--      due this week = 18,400 x days from 22 Oct to today, not just the two billed days
--   B  no plan's due is above a normal week (daily x days) or above what was left at the week start,
--      except weekly-frequency plans and plans finished in the week, which keep their own rules
--   C  nothing counts above what was paid, nor above due (except finished plans)
--   D  15-21 Oct: no expired tenant gets days before the expired-plan billing go-live (19 Oct)
--   E  per-plan lines add up to the saved weekly result for every agent (gate and page agree)
--   F  the judged week's saved results match the new calculation
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_week date := public._agent_rule_judged_week_start();
  v_cur  date := public._agent_rule_week_start((now() AT TIME ZONE 'Africa/Kampala')::date);
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_shafeeq uuid := '98b7b07a-3d03-4600-b94e-cda122bbe4ae';
  v_ok boolean;
  v_due numeric;
  v_n int;
BEGIN
  -- A
  SELECT l.due INTO v_due
    FROM public._agent_weekly_plan_lines(v_shafeeq, v_cur, v_today) l
   WHERE l.rent_request_id::text LIKE '138a3244%';
  r := r || jsonb_build_object('step', 'A stopped tenant counts a normal week (18,400 x days so far)',
                               'pass', v_due = 18400 * (v_today - GREATEST(v_cur, date '2026-10-19') + 1),
                               'detail', v_due);

  -- B, over every agent with a bill or a repaying plan, for the week in progress and the judged week
  WITH agents AS (
    SELECT DISTINCT a.agent_id, wk.lo
    FROM (VALUES (v_cur), (v_week)) wk(lo)
    CROSS JOIN LATERAL (
      SELECT e.agent_id FROM public.agent_expected_day_plans e
       WHERE e.day BETWEEN wk.lo AND wk.lo + 6 AND e.agent_id IS NOT NULL
      UNION
      SELECT COALESCE(rr.assigned_agent_id, rr.agent_id) FROM public.rent_requests rr
       WHERE rr.status = 'repaying' AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
    ) a
  ), lines AS (
    SELECT a.agent_id, a.lo, LEAST(a.lo + 6, v_today) AS hi, l.*,
           rr.status, rr.daily_repayment, lower(COALESCE(rr.repayment_frequency, 'daily')) AS freq
    FROM agents a
    CROSS JOIN LATERAL public._agent_weekly_plan_lines(a.agent_id, a.lo, LEAST(a.lo + 6, v_today)) l
    JOIN public.rent_requests rr ON rr.id = l.rent_request_id
  )
  SELECT bool_and(due <= daily_repayment * (hi - lo + 1) + 1
                  OR freq = 'weekly' OR status = 'completed'
                  OR due = (SELECT COALESCE(sum(e.expected_ugx), 0) FROM public.agent_expected_day_plans e
                             WHERE e.rent_request_id = lines.rent_request_id AND e.agent_id = lines.agent_id
                               AND e.day BETWEEN lines.lo AND lines.hi)),
         count(*)
    INTO v_ok, v_n
  FROM lines;
  r := r || jsonb_build_object('step', 'B no plan due above a normal week unless it was actually billed that much', 'pass', v_ok,
                               'detail', v_n || ' plan lines checked');

  WITH agents AS (
    SELECT DISTINCT a.agent_id, wk.lo
    FROM (VALUES (v_cur), (v_week)) wk(lo)
    CROSS JOIN LATERAL (
      SELECT e.agent_id FROM public.agent_expected_day_plans e
       WHERE e.day BETWEEN wk.lo AND wk.lo + 6 AND e.agent_id IS NOT NULL
      UNION
      SELECT COALESCE(rr.assigned_agent_id, rr.agent_id) FROM public.rent_requests rr
       WHERE rr.status = 'repaying' AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
    ) a
  )
  SELECT bool_and(l.collected <= l.paid_raw AND (l.collected <= l.due OR rr.status = 'completed'))
    INTO v_ok
  FROM agents a
  CROSS JOIN LATERAL public._agent_weekly_plan_lines(a.agent_id, a.lo, LEAST(a.lo + 6, v_today)) l
  JOIN public.rent_requests rr ON rr.id = l.rent_request_id;
  r := r || jsonb_build_object('step', 'C counted never above paid, nor above due except finished plans', 'pass', v_ok);

  -- D: in 15-21 Oct an unbilled expired tenant gets at most 3 days (19-21 Oct)
  SELECT bool_and(l.due <= rr.daily_repayment * 3 + 1
                  -- or exactly what this agent was billed (a plan transferred mid-week is split by day)
                  OR l.due = (SELECT COALESCE(sum(e.expected_ugx), 0) FROM public.agent_expected_day_plans e
                               WHERE e.rent_request_id = l.rent_request_id AND e.agent_id = s.agent_id
                                 AND e.day BETWEEN date '2026-10-15' AND date '2026-10-21'))
    INTO v_ok
  FROM public.agent_weekly_posting_eligibility s
  CROSS JOIN LATERAL public._agent_weekly_plan_lines(s.agent_id, date '2026-10-15', date '2026-10-21') l
  JOIN public.rent_requests rr ON rr.id = l.rent_request_id
  WHERE s.week_start = date '2026-10-15' AND l.expired AND rr.status = 'repaying'
    AND lower(COALESCE(rr.repayment_frequency, 'daily')) <> 'weekly';
  r := r || jsonb_build_object('step', 'D 15-21 Oct: no days added before the 19 Oct go-live', 'pass', COALESCE(v_ok, true));

  -- E
  SELECT bool_and(s.in_window_collected = x.in_got AND s.expired_collected = x.ex_got
                  AND s.in_window_due = x.in_due AND s.expired_due = x.ex_due)
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
  r := r || jsonb_build_object('step', 'E plan lines add up to the saved result (all agents)', 'pass', v_ok);

  -- F
  SELECT bool_and(l.passes = s.passes AND l.expired_due = s.expired_due AND l.expired_collected = s.expired_collected)
    INTO v_ok
  FROM public.agent_weekly_posting_eligibility s
  CROSS JOIN LATERAL public._agent_weekly_posting_compute(s.week_start, ARRAY[s.agent_id]) l
  WHERE s.week_start = v_week;
  r := r || jsonb_build_object('step', 'F saved judged week matches the new calculation', 'pass', v_ok);

  RAISE EXCEPTION 'REPORT %', r;
END
$test$;

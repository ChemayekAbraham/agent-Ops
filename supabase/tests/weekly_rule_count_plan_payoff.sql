-- Rolled-back verification for 20261026090000_weekly_rule_count_plan_payoff.sql
--
-- Run against the live database after the migration. The block ends in RAISE EXCEPTION, so nothing is
-- kept; the error text IS the report.
--
--   A  Nyaddoi Christine's plan (cleared 35,166 on 22 Oct) counts the full 35,166 this week
--   B  every plan that is NOT finished in the week still counts at most what it was billed
--   C  a finished plan never counts more than what was paid, nor more than was left at the week start
--   D  a plan finished in a LATER week gets no extra credit in an earlier week (15-21 Oct)
--   E  per-plan lines add up to the saved weekly result for every agent (gate and page agree)
--   F  the judged week's snapshot was re-saved after the change
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_week date := public._agent_rule_judged_week_start();
  v_cur  date := public._agent_rule_week_start((now() AT TIME ZONE 'Africa/Kampala')::date);
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_alpha uuid := '9188db01-e54a-4f84-8de9-042e6b5b6bd6';
  v_ok boolean;
  v_n int;
  v_got numeric;
BEGIN
  -- A
  SELECT l.collected INTO v_got
    FROM public._agent_weekly_plan_lines(v_alpha, date '2026-10-22', v_today) l
   WHERE l.rent_request_id::text LIKE '0d70c521%';
  r := r || jsonb_build_object('step', 'A plan cleared on 22 Oct counts the whole 35,166', 'pass', v_got = 35166, 'detail', v_got);

  -- B and C, over every agent with a bill in the week in progress and the judged week
  WITH agents AS (
    SELECT DISTINCT e.agent_id, wk.lo
    FROM (VALUES (v_cur), (v_week)) wk(lo)
    JOIN public.agent_expected_day_plans e ON e.day BETWEEN wk.lo AND wk.lo + 6 AND e.agent_id IS NOT NULL
  ), lines AS (
    SELECT a.agent_id, a.lo, l.*, rr.status, rr.total_repayment, rr.amount_repaid
    FROM agents a
    CROSS JOIN LATERAL public._agent_weekly_plan_lines(a.agent_id, a.lo, LEAST(a.lo + 6, v_today)) l
    JOIN public.rent_requests rr ON rr.id = l.rent_request_id
  )
  SELECT bool_and(collected <= paid_raw)
     AND bool_and(collected <= due OR status = 'completed')
     AND bool_and(collected <= GREATEST(due, GREATEST(total_repayment - (amount_repaid - paid_raw), 0))),
         count(*) FILTER (WHERE collected > due)
    INTO v_ok, v_n
  FROM lines;
  r := r || jsonb_build_object('step', 'B/C only finished plans exceed their bill, never above paid or what was left', 'pass', v_ok,
                               'detail', v_n || ' plan lines credited above their bill');

  -- D: plans completed now but still billed after 21 Oct get no extra credit for 15-21 Oct
  SELECT bool_and(l.collected <= l.due) INTO v_ok
  FROM (SELECT DISTINCT e.agent_id, e.rent_request_id
          FROM public.agent_expected_day_plans e
          JOIN public.rent_requests rr ON rr.id = e.rent_request_id
         WHERE e.day BETWEEN date '2026-10-15' AND date '2026-10-21' AND rr.status = 'completed'
           AND EXISTS (SELECT 1 FROM public.agent_expected_day_plans x
                       WHERE x.rent_request_id = e.rent_request_id AND x.day > date '2026-10-21')) p
  CROSS JOIN LATERAL public._agent_weekly_plan_lines(p.agent_id, date '2026-10-15', date '2026-10-21') l
  WHERE l.rent_request_id = p.rent_request_id;
  r := r || jsonb_build_object('step', 'D plan finished in a later week gets no early credit', 'pass', COALESCE(v_ok, true));

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
  SELECT bool_and(l.passes = s.passes AND l.in_window_collected = s.in_window_collected AND l.expired_collected = s.expired_collected)
    INTO v_ok
  FROM public.agent_weekly_posting_eligibility s
  CROSS JOIN LATERAL public._agent_weekly_posting_compute(s.week_start, ARRAY[s.agent_id]) l
  WHERE s.week_start = v_week;
  r := r || jsonb_build_object('step', 'F saved judged week matches the new calculation', 'pass', v_ok);

  RAISE EXCEPTION 'REPORT %', r;
END
$test$;

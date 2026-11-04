-- Agent "Weekly Performance" page data (builds on 20261023130000_agent_weekly_posting_rule.sql).
--
-- get_my_weekly_performance(p_weeks, p_agent_id) returns one jsonb document:
--   settings          the 50 / 20 / 70 targets and whether the weekly rule is enforced
--   current_week      this week (Thu..Wed) so far: billed so far, collected so far, and a projection of
--                     the full week's due (today's bill repeated for the days left), per group
--   weeks             the last p_weeks completed weeks, newest first; the judged week (the one that
--                     decides posting now) comes from the saved snapshot, older ones are recomputed
--   plans             this week's plans, one line each: tenant, group, billed so far, collected (capped)
--
-- Same definitions as the posting rule: groups fixed by the plan's window at the week's first day,
-- due from agent_expected_day_plans, collections non-reversed and capped per plan at its due.

-- One line per (plan) for an agent and week, using only bill days up to p_through.
CREATE OR REPLACE FUNCTION public._agent_weekly_plan_lines(p_agent_id uuid, p_week_start date, p_through date)
RETURNS TABLE(
  rent_request_id uuid, tenant_id uuid, expired boolean,
  due numeric, collected numeric, paid_raw numeric, billed_days integer, last_day_due numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH w AS (
    SELECT p_week_start AS lo, LEAST(p_week_start + 6, p_through) AS hi
  ), bill AS (
    SELECT e.rent_request_id,
           (array_agg(e.tenant_id) FILTER (WHERE e.tenant_id IS NOT NULL))[1] AS tenant_id,
           sum(e.expected_ugx) AS due,
           count(DISTINCT e.day)::int AS billed_days,
           sum(e.expected_ugx) FILTER (WHERE e.day = w.hi) AS last_day_due,
           bool_or(
             COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date)
               + COALESCE(rr.duration_days, 0) - 1 < w.lo
           ) AS expired
    FROM public.agent_expected_day_plans e
    JOIN public.rent_requests rr ON rr.id = e.rent_request_id
    CROSS JOIN w
    WHERE e.agent_id = p_agent_id
      AND e.day BETWEEN w.lo AND w.hi
      AND e.expected_ugx > 0
    GROUP BY e.rent_request_id
  )
  SELECT b.rent_request_id, b.tenant_id, b.expired, b.due,
         LEAST(COALESCE(c.paid, 0), b.due), COALESCE(c.paid, 0),
         b.billed_days, COALESCE(b.last_day_due, 0)
  FROM bill b
  CROSS JOIN w
  LEFT JOIN LATERAL (
    SELECT sum(ac.amount) AS paid
    FROM public.agent_collections ac
    WHERE ac.reversed_at IS NULL
      AND ac.amount > 0
      AND ac.agent_id = p_agent_id
      AND (ac.rent_request_id = b.rent_request_id
           OR (ac.rent_request_id IS NULL AND ac.tenant_id IS NOT NULL AND ac.tenant_id = b.tenant_id))
      AND ac.created_at >= (w.lo::timestamp AT TIME ZONE 'Africa/Kampala')
      AND ac.created_at <  ((w.hi + 1)::timestamp AT TIME ZONE 'Africa/Kampala')
  ) c ON true;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_weekly_performance(p_weeks integer DEFAULT 6, p_agent_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_agent   uuid := COALESCE(p_agent_id, auth.uid());
  v_today   date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_cur     date;
  v_judged  date;
  v_s       public.agent_posting_rule_settings;
  v_weeks   jsonb := '[]'::jsonb;
  v_row     public.agent_weekly_posting_eligibility;
  v_wk      date;
  v_days_left int;
  v_current jsonb;
  v_plans   jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING errcode = '42501';
  END IF;
  -- Yourself, your network, or staff reports (same rule as the eligibility reads).
  IF v_agent IS DISTINCT FROM v_uid
     AND NOT public.can_view_staff_reports(v_uid)
     AND v_agent NOT IN (SELECT public.agent_wallet_network_ids(v_uid)) THEN
    RAISE EXCEPTION 'not authorized' USING errcode = '42501';
  END IF;

  SELECT * INTO v_s FROM public.agent_posting_rule_settings WHERE id;
  v_cur    := public._agent_rule_week_start(v_today);
  v_judged := v_cur - 7;
  v_days_left := (v_cur + 6) - v_today;  -- whole days after today still to be billed this week
  p_weeks := LEAST(GREATEST(COALESCE(p_weeks, 6), 1), 12);

  -- Completed weeks, newest first. The judged week reads the same result the gate uses.
  FOR i IN 0 .. p_weeks - 1 LOOP
    v_wk := v_judged - 7 * i;
    IF i = 0 THEN
      v_row := public._agent_weekly_posting_result(v_agent);
    ELSE
      v_row := NULL;
      SELECT * INTO v_row FROM public._agent_weekly_posting_compute(v_wk, ARRAY[v_agent]);
    END IF;
    v_weeks := v_weeks || jsonb_build_object(
      'week_start', v_wk, 'week_end', v_wk + 6, 'is_judged', i = 0,
      'book', COALESCE(v_row.book, 'none'),
      'in_window_due', COALESCE(v_row.in_window_due, 0), 'in_window_collected', COALESCE(v_row.in_window_collected, 0),
      'in_window_plans', COALESCE(v_row.in_window_plans, 0), 'in_window_pct', v_row.in_window_pct,
      'in_window_required_pct', v_row.in_window_required_pct,
      'expired_due', COALESCE(v_row.expired_due, 0), 'expired_collected', COALESCE(v_row.expired_collected, 0),
      'expired_plans', COALESCE(v_row.expired_plans, 0), 'expired_pct', v_row.expired_pct,
      'expired_required_pct', v_row.expired_required_pct,
      'passes', COALESCE(v_row.passes, true), 'reason', v_row.reason
    );
  END LOOP;

  -- This week so far, per group, with a full-week projection.
  WITH l AS (
    SELECT * FROM public._agent_weekly_plan_lines(v_agent, v_cur, v_today)
  ), g AS (
    SELECT
      COALESCE(sum(due) FILTER (WHERE NOT expired), 0) AS in_due,
      COALESCE(sum(collected) FILTER (WHERE NOT expired), 0) AS in_got,
      count(*) FILTER (WHERE NOT expired)::int AS in_plans,
      -- Projection: plans billed today are assumed to be billed the same amount on each day left.
      COALESCE(sum(due + last_day_due * v_days_left) FILTER (WHERE NOT expired), 0) AS in_proj,
      COALESCE(sum(due) FILTER (WHERE expired), 0) AS ex_due,
      COALESCE(sum(collected) FILTER (WHERE expired), 0) AS ex_got,
      count(*) FILTER (WHERE expired)::int AS ex_plans,
      COALESCE(sum(due + last_day_due * v_days_left) FILTER (WHERE expired), 0) AS ex_proj
    FROM l
  )
  SELECT jsonb_build_object(
    'week_start', v_cur, 'week_end', v_cur + 6, 'today', v_today,
    'days_elapsed', v_today - v_cur + 1, 'days_left', v_days_left,
    'book', CASE WHEN g.in_proj > 0 AND g.ex_proj > 0 THEN 'mixed'
                 WHEN g.in_proj > 0 THEN 'in_window_only'
                 WHEN g.ex_proj > 0 THEN 'all_expired' ELSE 'none' END,
    'in_window_due_so_far', g.in_due, 'in_window_collected', g.in_got, 'in_window_plans', g.in_plans,
    'in_window_projected_due', g.in_proj,
    'expired_due_so_far', g.ex_due, 'expired_collected', g.ex_got, 'expired_plans', g.ex_plans,
    'expired_projected_due', g.ex_proj,
    'in_window_required_pct', CASE WHEN g.in_proj > 0 THEN v_s.in_window_required_pct END,
    'expired_required_pct', CASE WHEN g.ex_proj > 0 AND g.in_proj > 0 THEN v_s.expired_required_pct
                                 WHEN g.ex_proj > 0 THEN v_s.all_expired_required_pct END
  ) INTO v_current
  FROM g;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'rent_request_id', l.rent_request_id,
           'tenant_id', l.tenant_id,
           'tenant_name', COALESCE(p.full_name, 'Tenant'),
           'tenant_phone', p.phone,
           'expired', l.expired,
           'due_so_far', l.due,
           'collected', l.collected,
           'paid_raw', l.paid_raw,
           'daily_due', l.last_day_due
         ) ORDER BY l.expired, (l.due - l.collected) DESC), '[]'::jsonb)
    INTO v_plans
  FROM public._agent_weekly_plan_lines(v_agent, v_cur, v_today) l
  LEFT JOIN public.profiles p ON p.id = l.tenant_id;

  RETURN jsonb_build_object(
    'agent_id', v_agent,
    'settings', jsonb_build_object(
      'in_window_required_pct', v_s.in_window_required_pct,
      'expired_required_pct', v_s.expired_required_pct,
      'all_expired_required_pct', v_s.all_expired_required_pct,
      'enforced', v_s.enforce_weekly),
    'current_week', v_current,
    'weeks', v_weeks,
    'plans', v_plans
  );
END
$function$;

REVOKE ALL ON FUNCTION public._agent_weekly_plan_lines(uuid, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_weekly_plan_lines(uuid, date, date) TO service_role;
REVOKE ALL ON FUNCTION public.get_my_weekly_performance(integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_weekly_performance(integer, uuid) TO authenticated, service_role;

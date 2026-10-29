-- Weekly Performance: the full-week projection counted a weekly Rent Plan's lump once per day left.
-- On day 1 an agent with one 625,338 weekly tenant billed on Thursday saw 3.75M extra on the target, and a weekly
-- tenant billed later in the week was not projected at all. Weekly and monthly plans now project from their
-- real instalments (rent_plan_schedule_days); daily plans keep "today's bill on each day left".
-- Only the mid-week estimate changes. The judged result (_agent_weekly_posting_compute) uses real bills and is
-- untouched, as is rent_request_agent_week_pct (it never projected). CREATE OR REPLACE keeps the grants.

CREATE OR REPLACE FUNCTION public.get_my_weekly_performance(p_weeks integer DEFAULT 6, p_agent_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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

  -- This week so far, per group, with a full-week projection (20261029190000).
  -- Daily plans: billed today, assumed billed the same amount on each day left (past-term billing is daily too).
  -- Weekly / monthly plans: their real instalments from rent_plan_schedule_days for the days left, never today's
  -- lump times the days left. A weekly plan whose bill falls later this week is projected too.
  WITH l AS (
    SELECT * FROM public._agent_weekly_plan_lines(v_agent, v_cur, v_today)
  ), sched AS (
    SELECT g.rent_request_id, sum(g.amount) AS amt
    FROM public.rent_plan_schedule_days(v_today + 1, v_cur + 6) g
    JOIN public.rent_requests rr ON rr.id = g.rent_request_id
    WHERE v_days_left > 0
      AND COALESCE(rr.assigned_agent_id, rr.agent_id) = v_agent
      AND rr.status = 'repaying'
      AND lower(COALESCE(rr.repayment_frequency, 'daily')) IN ('weekly', 'monthly')
      AND g.due_on >= public.rent_plan_billable_from(rr.id)
    GROUP BY g.rent_request_id
  ), x AS (
    SELECT COALESCE(l.expired, false) AS expired,
           COALESCE(l.due, 0) AS due,
           COALESCE(l.collected, 0) AS collected,
           CASE WHEN lower(COALESCE(rr.repayment_frequency, 'daily')) IN ('weekly', 'monthly')
                THEN COALESCE(s.amt, 0)
                ELSE COALESCE(l.last_day_due, 0) * v_days_left
           END AS rest
    FROM l
    FULL JOIN sched s ON s.rent_request_id = l.rent_request_id
    LEFT JOIN public.rent_requests rr ON rr.id = COALESCE(l.rent_request_id, s.rent_request_id)
  ), g AS (
    SELECT
      COALESCE(sum(due) FILTER (WHERE NOT expired), 0) AS in_due,
      COALESCE(sum(collected) FILTER (WHERE NOT expired), 0) AS in_got,
      count(*) FILTER (WHERE NOT expired AND due + rest > 0)::int AS in_plans,
      COALESCE(sum(due + rest) FILTER (WHERE NOT expired), 0) AS in_proj,
      COALESCE(sum(due) FILTER (WHERE expired), 0) AS ex_due,
      COALESCE(sum(collected) FILTER (WHERE expired), 0) AS ex_got,
      count(*) FILTER (WHERE expired AND due + rest > 0)::int AS ex_plans,
      COALESCE(sum(due + rest) FILTER (WHERE expired), 0) AS ex_proj
    FROM x
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

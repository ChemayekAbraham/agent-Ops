-- Restores the through-today function of 20261026170000 (drops the through-yesterday version first).
DROP FUNCTION IF EXISTS public.rent_request_agent_week_pct(uuid[]);

-- The registering agent's collection figures for the current Thursday-Wednesday week, for the rent request desks.
-- ONE NEW read-only function; nothing existing is altered, no approval, routing, commission or status logic is touched, no index is added.
--
--   rent_request_agent_week_pct(p_request_ids uuid[])   one row per distinct REGISTERING agent (rent_requests.agent_id) among the requests
--
-- It does not calculate a new measure. It reads the same pieces the agent's own "Weekly performance" screen reads (get_my_weekly_performance):
--   week            _agent_rule_week_start(today, Kampala) = the Thursday-Wednesday week that contains today (agent_posting_rule_settings.week_start_isodow = 4)
--   plan lines      _agent_weekly_plan_lines(agent, week_start, today)  (collections are capped per Rent Plan at what it was due)
--   groups          current Rent Plans ("in window") and expired Rent Plans, with the same projected full-week due and the same required % as that screen
--   last judged wk  _agent_weekly_posting_result(agent)  (the week that decides posting; null columns when nothing was billed)
-- The percentage the agent sees is collected / projected full-week due; callers compute it from the amounts returned here so it is identical.
-- The registering agent is the one that registered the tenant, whether or not they are a sub-agent.
--
-- Access: exactly the rent desk gate of rent_request_desk_order: auth.uid() required; desk staff (_am_staff_ok(), landlord_ops, partner_ops) may ask for any
-- request; anyone else (a service centre manager) only for requests where rent_requests.service_center_manager_id = auth.uid(); otherwise 42501.
-- At most 5000 request ids per call (22023 TOO_MANY_IDS). SECURITY DEFINER, STABLE, search_path = public. EXECUTE for authenticated only.
-- Rollback: supabase/rollbacks/20261026170000_rent_request_agent_week_pct.rollback.sql

CREATE FUNCTION public.rent_request_agent_week_pct(p_request_ids uuid[])
RETURNS TABLE (
  agent_id uuid,
  week_start date, week_end date, days_left integer, book text,
  in_window_plans integer, in_window_collected numeric, in_window_due_so_far numeric, in_window_projected_due numeric, in_window_required_pct numeric,
  expired_plans integer, expired_collected numeric, expired_due_so_far numeric, expired_projected_due numeric, expired_required_pct numeric,
  last_week_start date, last_week_end date, last_book text, last_in_window_pct numeric, last_expired_pct numeric, last_passes boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
#variable_conflict use_column
DECLARE
  v_uid   uuid := auth.uid();
  v_ids   uuid[];
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_cur   date;
  v_last  date;
  v_left  int;
  v_s     public.agent_posting_rule_settings;
  v_desk  boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::uuid[]) INTO v_ids FROM unnest(COALESCE(p_request_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL;

  v_desk := public._am_staff_ok()
         OR EXISTS (SELECT 1 FROM public.user_roles ur
                     WHERE ur.user_id = v_uid AND ur.enabled = true AND ur.role::text IN ('landlord_ops', 'partner_ops'));
  IF NOT v_desk THEN
    IF cardinality(v_ids) = 0
       OR EXISTS (SELECT 1 FROM unnest(v_ids) AS i(id)
                   WHERE NOT EXISTS (SELECT 1 FROM public.rent_requests rr WHERE rr.id = i.id AND rr.service_center_manager_id = v_uid)) THEN
      RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF cardinality(v_ids) = 0 THEN
    RETURN;
  END IF;
  IF cardinality(v_ids) > 5000 THEN
    RAISE EXCEPTION 'TOO_MANY_IDS: at most 5000 request ids per call' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_s FROM public.agent_posting_rule_settings WHERE id;
  v_cur  := public._agent_rule_week_start(v_today);
  v_last := public._agent_rule_judged_week_start();
  v_left := (v_cur + 6) - v_today;

  RETURN QUERY
  WITH ag AS (
    SELECT DISTINCT rr.agent_id AS aid FROM public.rent_requests rr WHERE rr.id = ANY (v_ids) AND rr.agent_id IS NOT NULL
  ), g AS (
    SELECT a.aid,
           COALESCE(sum(l.due) FILTER (WHERE NOT l.expired), 0)                              AS in_due,
           COALESCE(sum(l.collected) FILTER (WHERE NOT l.expired), 0)                        AS in_got,
           (count(l.rent_request_id) FILTER (WHERE NOT l.expired))::int                      AS in_plans,
           COALESCE(sum(l.due + l.last_day_due * v_left) FILTER (WHERE NOT l.expired), 0)    AS in_proj,
           COALESCE(sum(l.due) FILTER (WHERE l.expired), 0)                                  AS ex_due,
           COALESCE(sum(l.collected) FILTER (WHERE l.expired), 0)                            AS ex_got,
           (count(l.rent_request_id) FILTER (WHERE l.expired))::int                          AS ex_plans,
           COALESCE(sum(l.due + l.last_day_due * v_left) FILTER (WHERE l.expired), 0)        AS ex_proj
      FROM ag a
      LEFT JOIN LATERAL public._agent_weekly_plan_lines(a.aid, v_cur, v_today) l ON true
     GROUP BY a.aid
  )
  SELECT g.aid,
         v_cur, v_cur + 6, v_left,
         CASE WHEN g.in_proj > 0 AND g.ex_proj > 0 THEN 'mixed'
              WHEN g.in_proj > 0 THEN 'in_window_only'
              WHEN g.ex_proj > 0 THEN 'all_expired' ELSE 'none' END,
         g.in_plans, g.in_got, g.in_due, g.in_proj,
         CASE WHEN g.in_proj > 0 THEN v_s.in_window_required_pct END,
         g.ex_plans, g.ex_got, g.ex_due, g.ex_proj,
         CASE WHEN g.ex_proj > 0 AND g.in_proj > 0 THEN v_s.expired_required_pct
              WHEN g.ex_proj > 0 THEN v_s.all_expired_required_pct END,
         v_last, v_last + 6, j.book, j.in_window_pct, j.expired_pct, j.passes
    FROM g
    LEFT JOIN LATERAL (
      SELECT (s.x).book AS book, (s.x).in_window_pct AS in_window_pct, (s.x).expired_pct AS expired_pct, (s.x).passes AS passes
        FROM (SELECT public._agent_weekly_posting_result(g.aid) AS x) s
    ) j ON true;
END;
$function$;

COMMENT ON FUNCTION public.rent_request_agent_week_pct(uuid[]) IS 'This Thursday-Wednesday week''s collection figures of the registering agent of each rent request (the same figures the agent sees on Weekly performance), plus the last judged week. Read-only.';

REVOKE ALL ON FUNCTION public.rent_request_agent_week_pct(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.rent_request_agent_week_pct(uuid[]) TO authenticated;

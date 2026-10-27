-- The registering agent's collection figures for the current Thursday-Wednesday week, counted from Thursday THROUGH YESTERDAY (Kampala), so an agent who is
-- still collecting today is not marked down for today. Replaces rent_request_agent_week_pct (migration 20261026170000) with the same name and the same
-- access rules; nothing else is altered. The old function returned the projected full-week due and figures through today; those columns are gone, so it is
-- dropped and created again (execute is granted again below).
--
--   expected so far  = what the agent's Rent Plans were billed from the week's Thursday through yesterday   (_agent_weekly_plan_lines, `due`)
--   collected so far = what was collected on those Rent Plans in the same days, capped per Rent Plan at what it was due   (`collected`)
--   percentage       = collected so far / expected so far (callers compute it from these two amounts)
-- Both restart every Thursday. On a Thursday nothing has been counted yet (yesterday was last week), so every figure is zero and the desks show "-".
-- The registering agent is rent_requests.agent_id, sub-agent or not. Current Rent Plans are the main group, expired Rent Plans a second one, with the same
-- required % as the agent's Weekly performance screen. The last judged week is read as before (_agent_weekly_posting_result).
--
-- Access: unchanged, the rent desk gate of rent_request_desk_order (desk staff for any request; a service centre manager only for their own requests;
-- otherwise 42501). At most 5000 request ids per call (22023). SECURITY DEFINER, STABLE, search_path = public. EXECUTE for authenticated only.
-- Rollback: supabase/rollbacks/20261026190000_rent_request_agent_week_pct_through_yesterday.rollback.sql (restores the 20261026170000 function)

DROP FUNCTION IF EXISTS public.rent_request_agent_week_pct(uuid[]);

CREATE FUNCTION public.rent_request_agent_week_pct(p_request_ids uuid[])
RETURNS TABLE (
  agent_id uuid,
  week_start date, week_end date, through_day date, book text,
  in_window_plans integer, in_window_collected numeric, in_window_due_so_far numeric, in_window_required_pct numeric,
  expired_plans integer, expired_collected numeric, expired_due_so_far numeric, expired_required_pct numeric,
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
  v_thru  date;
  v_last  date;
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
  v_thru := v_today - 1;                       -- yesterday; before the week's Thursday means nothing is counted yet
  v_last := public._agent_rule_judged_week_start();

  RETURN QUERY
  WITH ag AS (
    SELECT DISTINCT rr.agent_id AS aid FROM public.rent_requests rr WHERE rr.id = ANY (v_ids) AND rr.agent_id IS NOT NULL
  ), g AS (
    SELECT a.aid,
           COALESCE(sum(l.due) FILTER (WHERE NOT l.expired), 0)                  AS in_due,
           COALESCE(sum(l.collected) FILTER (WHERE NOT l.expired), 0)            AS in_got,
           (count(l.rent_request_id) FILTER (WHERE NOT l.expired))::int          AS in_plans,
           COALESCE(sum(l.due) FILTER (WHERE l.expired), 0)                      AS ex_due,
           COALESCE(sum(l.collected) FILTER (WHERE l.expired), 0)                AS ex_got,
           (count(l.rent_request_id) FILTER (WHERE l.expired))::int              AS ex_plans
      FROM ag a
      LEFT JOIN LATERAL (
        SELECT * FROM public._agent_weekly_plan_lines(a.aid, v_cur, v_thru) WHERE v_thru >= v_cur
      ) l ON true
     GROUP BY a.aid
  )
  SELECT g.aid,
         v_cur, v_cur + 6, CASE WHEN v_thru >= v_cur THEN v_thru END,
         CASE WHEN g.in_due > 0 AND g.ex_due > 0 THEN 'mixed'
              WHEN g.in_due > 0 THEN 'in_window_only'
              WHEN g.ex_due > 0 THEN 'all_expired' ELSE 'none' END,
         g.in_plans, g.in_got, g.in_due,
         CASE WHEN g.in_due > 0 THEN v_s.in_window_required_pct END,
         g.ex_plans, g.ex_got, g.ex_due,
         CASE WHEN g.ex_due > 0 AND g.in_due > 0 THEN v_s.expired_required_pct
              WHEN g.ex_due > 0 THEN v_s.all_expired_required_pct END,
         v_last, v_last + 6, j.book, j.in_window_pct, j.expired_pct, j.passes
    FROM g
    LEFT JOIN LATERAL (
      SELECT (s.x).book AS book, (s.x).in_window_pct AS in_window_pct, (s.x).expired_pct AS expired_pct, (s.x).passes AS passes
        FROM (SELECT public._agent_weekly_posting_result(g.aid) AS x) s
    ) j ON true;
END;
$function$;

COMMENT ON FUNCTION public.rent_request_agent_week_pct(uuid[]) IS 'This Thursday-Wednesday week''s expected and collected amounts of the registering agent of each rent request, counted from Thursday through yesterday (Kampala), plus the last judged week. Read-only.';

REVOKE ALL ON FUNCTION public.rent_request_agent_week_pct(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.rent_request_agent_week_pct(uuid[]) TO authenticated;

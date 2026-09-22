-- Active-agent breakdown for the Agent Ops "Active Agents" card and its weekly modal.
-- get_agent_ops_overview reports active_agents_curr as every distinct collector
-- (sub-agents included) and active_subagents_curr as the sub-agent slice of that same
-- set, so adding them double-counted sub-agents, while a primary agent whose
-- sub-agents did the collecting counted as inactive.
-- This function returns the two groups as disjoint sets.
CREATE OR REPLACE FUNCTION public.get_agent_active_breakdown(
  p_range_start timestamptz,
  p_range_end timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_prev_start timestamptz;
  v_prev_end timestamptz := p_range_start;
  v_span interval;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;
  IF NOT (
    public.is_ops_role(v_uid)
    OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'ceo')
    OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'cto')
    OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  v_span := p_range_end - p_range_start;
  v_prev_start := p_range_start - v_span;

  WITH links AS (
    SELECT DISTINCT sub_agent_id, parent_agent_id
      FROM agent_subagents
     WHERE sub_agent_id IS NOT NULL AND parent_agent_id IS NOT NULL
  ),
  sub_ids AS (SELECT DISTINCT sub_agent_id FROM links),
  coll AS (
    SELECT ac.agent_id AS uid,
           (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
           ac.created_at
      FROM agent_collections ac
     WHERE ac.agent_id IS NOT NULL
       AND ac.reversed_at IS NULL
       AND ac.created_at >= v_prev_start
       AND ac.created_at < p_range_end
  ),
  w AS (
    SELECT uid, day,
           (created_at >= p_range_start AND created_at < p_range_end) AS is_curr,
           (created_at >= v_prev_start AND created_at < v_prev_end) AS is_prev
      FROM coll
  ),
  subs AS (
    SELECT w.uid, w.day, w.is_curr, w.is_prev
      FROM w WHERE w.uid IN (SELECT sub_agent_id FROM sub_ids)
  ),
  direct AS (
    SELECT w.uid, w.day, w.is_curr, w.is_prev
      FROM w WHERE w.uid NOT IN (SELECT sub_agent_id FROM sub_ids)
  ),
  via_team AS (
    SELECT l.parent_agent_id AS uid, s.day, s.is_curr, s.is_prev
      FROM subs s
      JOIN links l ON l.sub_agent_id = s.uid
     WHERE l.parent_agent_id NOT IN (SELECT sub_agent_id FROM sub_ids)
  ),
  agents AS (
    SELECT * FROM direct
    UNION ALL
    SELECT * FROM via_team
  ),
  days AS (
    SELECT generate_series(
             date_trunc('day', p_range_start),
             date_trunc('day', p_range_end - interval '1 second'),
             interval '1 day'
           ) AS ts
  ),
  daily AS (
    SELECT d.ts,
           (SELECT count(DISTINCT a.uid) FROM agents a
              WHERE a.is_curr AND a.day = (d.ts AT TIME ZONE 'Africa/Kampala')::date) AS agents,
           (SELECT count(DISTINCT s.uid) FROM subs s
              WHERE s.is_curr AND s.day = (d.ts AT TIME ZONE 'Africa/Kampala')::date) AS subagents
      FROM days d
  )
  SELECT jsonb_build_object(
    'agents_curr',    (SELECT count(DISTINCT uid) FROM agents WHERE is_curr),
    'agents_prev',    (SELECT count(DISTINCT uid) FROM agents WHERE is_prev),
    'subagents_curr', (SELECT count(DISTINCT uid) FROM subs WHERE is_curr),
    'subagents_prev', (SELECT count(DISTINCT uid) FROM subs WHERE is_prev),
    'total_curr',     (SELECT count(DISTINCT uid) FROM agents WHERE is_curr)
                      + (SELECT count(DISTINCT uid) FROM subs WHERE is_curr),
    'total_prev',     (SELECT count(DISTINCT uid) FROM agents WHERE is_prev)
                      + (SELECT count(DISTINCT uid) FROM subs WHERE is_prev),
    'trend',          COALESCE((SELECT jsonb_agg(jsonb_build_object(
                         'day', ts, 'agents', agents, 'subagents', subagents
                       ) ORDER BY ts) FROM daily), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_agent_active_breakdown(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agent_active_breakdown(timestamptz, timestamptz) TO authenticated;
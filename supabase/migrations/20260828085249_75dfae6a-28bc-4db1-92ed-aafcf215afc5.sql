CREATE OR REPLACE FUNCTION public.get_agent_operational_population(p_as_of date DEFAULT current_date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_result jsonb;
  v_cutoff timestamptz;
  v_recent_from timestamptz;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  v_cutoff := ((p_as_of + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_recent_from := v_cutoff - interval '30 days';

  WITH live AS (
    SELECT rr.agent_id AS uid
      FROM public.rent_requests rr
     WHERE rr.agent_id IS NOT NULL AND rr.status IN ('funded','repaying')
    UNION
    SELECT rr.assigned_agent_id
      FROM public.rent_requests rr
     WHERE rr.assigned_agent_id IS NOT NULL AND rr.status IN ('funded','repaying')
  ),
  coll AS (
    SELECT DISTINCT ac.agent_id AS uid
      FROM public.agent_collections ac
     WHERE ac.agent_id IS NOT NULL AND ac.created_at < v_cutoff
  ),
  recent AS (
    SELECT DISTINCT ac.agent_id AS uid
      FROM public.agent_collections ac
     WHERE ac.agent_id IS NOT NULL
       AND ac.created_at >= v_recent_from AND ac.created_at < v_cutoff
  ),
  uni AS (
    SELECT uid FROM live
    UNION
    SELECT uid FROM coll
  ),
  cls AS (
    SELECT u.uid,
           (u.uid IN (SELECT uid FROM live) OR u.uid IN (SELECT uid FROM recent)) AS is_active,
           EXISTS (
             SELECT 1 FROM public.agent_subagents sa
              WHERE sa.sub_agent_id = u.uid AND sa.status = 'verified'
           ) AS is_sub
      FROM uni u
  )
  SELECT jsonb_build_object(
    'as_of', p_as_of,
    'total', (SELECT count(*) FROM cls),
    'active', (SELECT count(*) FROM cls WHERE is_active),
    'inactive', (SELECT count(*) FROM cls WHERE NOT is_active),
    'primary_total', (SELECT count(*) FROM cls WHERE NOT is_sub),
    'primary_active', (SELECT count(*) FROM cls WHERE NOT is_sub AND is_active),
    'primary_inactive', (SELECT count(*) FROM cls WHERE NOT is_sub AND NOT is_active),
    'sub_total', (SELECT count(*) FROM cls WHERE is_sub),
    'sub_active', (SELECT count(*) FROM cls WHERE is_sub AND is_active),
    'sub_inactive', (SELECT count(*) FROM cls WHERE is_sub AND NOT is_active),
    'ever_collected', (SELECT count(*) FROM coll),
    'live_plan_agents', (SELECT count(*) FROM live),
    'collected_last_30d', (SELECT count(*) FROM recent),
    'live_plan_no_collection', (SELECT count(*) FROM cls c
                                 WHERE c.uid IN (SELECT uid FROM live)
                                   AND c.uid NOT IN (SELECT uid FROM coll)),
    'verified_subagent_links', (SELECT count(DISTINCT sa.sub_agent_id)
                                  FROM public.agent_subagents sa WHERE sa.status = 'verified')
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_agent_operational_population(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agent_operational_population(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_operational_population(date) TO service_role;
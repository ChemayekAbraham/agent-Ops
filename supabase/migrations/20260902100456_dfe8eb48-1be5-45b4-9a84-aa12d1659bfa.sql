DROP FUNCTION IF EXISTS public.get_agent_operational_population(date);

CREATE OR REPLACE FUNCTION public.get_agent_operational_population(p_as_of date DEFAULT CURRENT_DATE, p_from date DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
  v_cutoff timestamptz;
  v_recent_from timestamptz;
  v_from date;
  v_window_from timestamptz;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  v_cutoff := ((p_as_of + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_recent_from := v_cutoff - interval '30 days';
  v_from := LEAST(COALESCE(p_from, p_as_of), p_as_of);
  v_window_from := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');

  WITH req AS (
    SELECT DISTINCT COALESCE(rr.assigned_agent_id, rr.agent_id) AS uid
      FROM public.rent_requests rr
     WHERE COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
       AND COALESCE(rr.assigned_agent_id, rr.agent_id) <> rr.tenant_id
       AND rr.created_at < v_cutoff
  ),
  live AS (
    SELECT rr.agent_id AS uid
      FROM public.rent_requests rr
     WHERE rr.agent_id IS NOT NULL AND rr.status IN ('funded','repaying') AND rr.created_at < v_cutoff
    UNION
    SELECT rr.assigned_agent_id
      FROM public.rent_requests rr
     WHERE rr.assigned_agent_id IS NOT NULL AND rr.status IN ('funded','repaying') AND rr.created_at < v_cutoff
  ),
  coll AS (
    SELECT DISTINCT ac.agent_id AS uid
      FROM public.agent_collections ac
     WHERE ac.agent_id IS NOT NULL AND ac.created_at < v_cutoff
  ),
  win AS (
    -- Period-scoped activity: collected inside the selected reporting window.
    SELECT DISTINCT ac.agent_id AS uid
      FROM public.agent_collections ac
     WHERE ac.agent_id IS NOT NULL
       AND ac.created_at >= v_window_from AND ac.created_at < v_cutoff
  ),
  recent AS (
    SELECT DISTINCT ac.agent_id AS uid
      FROM public.agent_collections ac
     WHERE ac.agent_id IS NOT NULL
       AND ac.created_at >= v_recent_from AND ac.created_at < v_cutoff
  ),
  uni AS (
    SELECT uid FROM req
    UNION
    SELECT uid FROM coll
  ),
  sub_reg AS (
    SELECT DISTINCT sa.sub_agent_id AS uid
      FROM public.agent_subagents sa
     WHERE sa.sub_agent_id IS NOT NULL
  ),
  cls AS (
    SELECT u.uid,
           (u.uid IN (SELECT uid FROM win)) AS is_active,
           (u.uid IN (SELECT uid FROM coll)) AS ever_active,
           (u.uid IN (SELECT uid FROM sub_reg)) AS is_sub
      FROM uni u
  )
  SELECT jsonb_build_object(
    'as_of', p_as_of,
    'window_from', v_from,
    'window_to', p_as_of,
    'total', (SELECT count(*) FROM cls),
    'active', (SELECT count(*) FROM cls WHERE is_active),
    'inactive', (SELECT count(*) FROM cls WHERE NOT is_active),
    'active_ever', (SELECT count(*) FROM cls WHERE ever_active),
    'primary_total', (SELECT count(*) FROM cls WHERE NOT is_sub),
    'primary_active', (SELECT count(*) FROM cls WHERE NOT is_sub AND is_active),
    'primary_inactive', (SELECT count(*) FROM cls WHERE NOT is_sub AND NOT is_active),
    'sub_total', (SELECT count(*) FROM sub_reg),
    'sub_active', (SELECT count(*) FROM sub_reg s WHERE s.uid IN (SELECT uid FROM win)),
    'sub_inactive', (SELECT count(*) FROM sub_reg s WHERE s.uid NOT IN (SELECT uid FROM win)),
    'ever_collected', (SELECT count(*) FROM coll),
    'collected_in_period', (SELECT count(*) FROM win),
    'live_plan_agents', (SELECT count(*) FROM live),
    'collected_last_30d', (SELECT count(*) FROM recent),
    'live_plan_no_collection', (SELECT count(*) FROM live l
                                 WHERE l.uid NOT IN (SELECT uid FROM win)),
    'verified_subagent_links', (SELECT count(DISTINCT sa.sub_agent_id)
                                  FROM public.agent_subagents sa WHERE sa.status = 'verified')
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_agent_operational_population(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_agent_operational_population(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_agent_operational_population(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_operational_population(date, date) TO service_role;
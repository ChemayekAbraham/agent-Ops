CREATE OR REPLACE FUNCTION public.tenant_location_correction_agents(p_search text DEFAULT NULL::text, p_limit integer DEFAULT 200)
 RETURNS TABLE(agent_id uuid, agent_name text, agent_phone text, total_tenants bigint, matched bigint, unmatched bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_q text := NULLIF(btrim(coalesce(p_search, '')), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT DISTINCT ON (r.tenant_id)
      r.tenant_id,
      coalesce(r.agent_id, r.assigned_agent_id) AS agent_id
    FROM public.rent_requests r
    WHERE r.tenant_id IS NOT NULL
      AND coalesce(r.agent_id, r.assigned_agent_id) IS NOT NULL
    ORDER BY r.tenant_id, r.created_at DESC
  )
  SELECT
    b.agent_id,
    ap.full_name AS agent_name,
    ap.phone AS agent_phone,
    count(*)::bigint AS total_tenants,
    count(*) FILTER (WHERE tp.ug_village_id IS NOT NULL)::bigint AS matched,
    count(*) FILTER (WHERE tp.ug_village_id IS NULL)::bigint AS unmatched
  FROM base b
  JOIN public.profiles tp ON tp.id = b.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = b.agent_id
  WHERE v_q IS NULL
    OR coalesce(ap.full_name, '') ILIKE '%' || v_q || '%'
    OR coalesce(ap.phone, '') ILIKE '%' || v_q || '%'
  GROUP BY b.agent_id, ap.full_name, ap.phone
  HAVING count(*) FILTER (WHERE tp.ug_village_id IS NULL) > 0
  ORDER BY count(*) FILTER (WHERE tp.ug_village_id IS NULL) DESC, ap.full_name NULLS LAST
  LIMIT greatest(1, least(coalesce(p_limit, 200), 500));
END;
$function$;

REVOKE ALL ON FUNCTION public.tenant_location_correction_agents(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tenant_location_correction_agents(text, integer) TO authenticated;
CREATE OR REPLACE FUNCTION public.agent_ops_strict_agent_ids()
RETURNS TABLE(agent_id uuid)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH listing_counts AS (
    SELECT hl.agent_id AS uid, count(*) AS n
      FROM house_listings hl
     WHERE hl.agent_id IS NOT NULL
     GROUP BY hl.agent_id
  )
  SELECT DISTINCT uid FROM (
    SELECT rr.agent_id AS uid FROM rent_requests rr
      WHERE rr.agent_id IS NOT NULL AND rr.tenant_id IS NOT NULL AND rr.agent_id <> rr.tenant_id
    UNION
    SELECT ac.agent_id FROM agent_collections ac WHERE ac.agent_id IS NOT NULL
    UNION
    SELECT lc.uid FROM listing_counts lc WHERE lc.n >= 3
  ) q
  WHERE uid IS NOT NULL;
$function$;

GRANT EXECUTE ON FUNCTION public.agent_ops_strict_agent_ids() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_agent_ops_top_agents(p_days int DEFAULT 30, p_limit int DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_since timestamptz := now() - (GREATEST(1, LEAST(365, p_days)) || ' days')::interval;
  v_out jsonb;
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

  WITH qual AS (
    SELECT agent_id FROM public.agent_ops_strict_agent_ids()
  ),
  comm AS (
    SELECT gl.user_id AS uid, COALESCE(sum(gl.amount),0) AS total
      FROM general_ledger gl
      JOIN qual q ON q.agent_id = gl.user_id
     WHERE gl.ledger_scope = 'wallet'
       AND gl.direction IN ('cash_in','credit')
       AND gl.category IN ('agent_commission_earned','agent_commission','agent_bonus')
       AND gl.created_at >= v_since
     GROUP BY gl.user_id
  ),
  ranked AS (
    SELECT * FROM comm WHERE total > 0 ORDER BY total DESC LIMIT GREATEST(1, LEAST(50, p_limit))
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'user_id', r.uid,
    'name', COALESCE(p.full_name, 'Unknown'),
    'phone', p.phone,
    'category', CASE WHEN s.sub_agent_id IS NOT NULL THEN 'Sub-Agent' ELSE 'Agent' END,
    'total', r.total
  ) ORDER BY r.total DESC), '[]'::jsonb)
  INTO v_out
  FROM ranked r
  LEFT JOIN profiles p ON p.id = r.uid
  LEFT JOIN LATERAL (
    SELECT sa.sub_agent_id FROM agent_subagents sa WHERE sa.sub_agent_id = r.uid LIMIT 1
  ) s ON true;

  RETURN COALESCE(v_out, '[]'::jsonb);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_agent_ops_top_agents(int, int) TO authenticated, service_role;
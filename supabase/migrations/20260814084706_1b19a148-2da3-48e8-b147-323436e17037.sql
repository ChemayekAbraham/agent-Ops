CREATE OR REPLACE FUNCTION public.get_service_center_qualification_candidates(
  p_min_progress numeric DEFAULT 50,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg public.service_center_qualification_config%ROWTYPE;
  v_total integer := 0;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.is_ops_role(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT * INTO v_cfg FROM public.service_center_qualification_config
   WHERE id = 'service_center_qualification_v1';

  CREATE TEMP TABLE IF NOT EXISTS _sc_cand (
    agent_id uuid,
    agent_name text,
    agent_phone text,
    avatar_url text,
    district text,
    region text,
    qualifying_sub_agents integer,
    main_agent_active_tenants integer,
    network_active_tenants integer,
    qualification_progress numeric,
    is_qualified boolean,
    existing_service_centres integer,
    request_status text
  ) ON COMMIT DROP;
  DELETE FROM _sc_cand;

  INSERT INTO _sc_cand
  WITH agents AS (
    SELECT DISTINCT ur.user_id AS agent_id
    FROM public.user_roles ur
    WHERE ur.role IN ('agent','senior_agent','sub_agent')
  ),
  personal AS (
    SELECT a.agent_id, count(DISTINCT rr.tenant_id)::int AS tenants
    FROM agents a
    JOIN public.rent_requests rr
      ON (rr.agent_id = a.agent_id OR rr.assigned_agent_id = a.agent_id)
    JOIN public.profiles tp ON tp.id = rr.tenant_id
    WHERE rr.status IN ('funded','repaying')
      AND COALESCE(rr.tenancy_status,'active') = 'active'
      AND COALESCE(tp.is_frozen,false) = false
    GROUP BY a.agent_id
  ),
  sub_links AS (
    SELECT DISTINCT s.parent_agent_id, s.sub_agent_id
    FROM public.agent_subagents s
    JOIN public.profiles sp ON sp.id = s.sub_agent_id
    WHERE s.status = 'verified'
      AND s.sub_agent_id <> s.parent_agent_id
      AND COALESCE(sp.is_frozen,false) = false
  ),
  sub_tenants AS (
    SELECT sl.parent_agent_id, sl.sub_agent_id, count(DISTINCT rr.tenant_id)::int AS tenants
    FROM sub_links sl
    JOIN public.rent_requests rr
      ON (rr.agent_id = sl.sub_agent_id OR rr.assigned_agent_id = sl.sub_agent_id)
    JOIN public.profiles tp ON tp.id = rr.tenant_id
    WHERE rr.status IN ('funded','repaying')
      AND COALESCE(rr.tenancy_status,'active') = 'active'
      AND COALESCE(tp.is_frozen,false) = false
    GROUP BY sl.parent_agent_id, sl.sub_agent_id
  ),
  sub_agg AS (
    SELECT parent_agent_id AS agent_id,
           count(*)::int AS sub_count,
           COALESCE(sum(tenants),0)::int AS sub_tenant_total
    FROM sub_tenants
    WHERE tenants >= 1
    GROUP BY parent_agent_id
  ),
  centres AS (
    SELECT agent_id, count(*)::int AS centres
    FROM public.service_centre_setups
    GROUP BY agent_id
  ),
  latest_req AS (
    SELECT DISTINCT ON (agent_id) agent_id, status
    FROM public.service_center_requests
    ORDER BY agent_id, created_at DESC
  ),
  scored AS (
    SELECT
      a.agent_id,
      COALESCE(p.full_name,'Unnamed agent') AS agent_name,
      p.phone AS agent_phone,
      p.avatar_url,
      p.district,
      p.region,
      COALESCE(sa.sub_count,0) AS qualifying_sub_agents,
      COALESCE(pt.tenants,0) AS main_agent_active_tenants,
      COALESCE(sa.sub_tenant_total,0) + COALESCE(pt.tenants,0) AS network_active_tenants,
      round(((
          LEAST(COALESCE(sa.sub_count,0)::numeric / NULLIF(v_cfg.required_sub_agents,0), 1)
        + LEAST(COALESCE(pt.tenants,0)::numeric / NULLIF(v_cfg.required_main_agent_tenants,0), 1)
      ) / 2) * 100) AS qualification_progress,
      (COALESCE(sa.sub_count,0) >= v_cfg.required_sub_agents
        AND COALESCE(pt.tenants,0) >= v_cfg.required_main_agent_tenants) AS is_qualified,
      COALESCE(c.centres,0) AS existing_service_centres,
      lr.status AS request_status
    FROM agents a
    JOIN public.profiles p ON p.id = a.agent_id
    LEFT JOIN personal pt ON pt.agent_id = a.agent_id
    LEFT JOIN sub_agg sa ON sa.agent_id = a.agent_id
    LEFT JOIN centres c ON c.agent_id = a.agent_id
    LEFT JOIN latest_req lr ON lr.agent_id = a.agent_id
    WHERE COALESCE(p.is_frozen,false) = false
  )
  SELECT * FROM scored
  WHERE qualification_progress >= COALESCE(p_min_progress, 50);

  SELECT count(*)::int INTO v_total FROM _sc_cand;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.qualification_progress DESC, t.agent_name), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT * FROM _sc_cand
    ORDER BY qualification_progress DESC, agent_name
    LIMIT GREATEST(COALESCE(p_limit,50),1)
    OFFSET GREATEST(COALESCE(p_offset,0),0)
  ) t;

  RETURN jsonb_build_object(
    'rule_version', v_cfg.rule_version,
    'required_sub_agents', v_cfg.required_sub_agents,
    'required_main_agent_tenants', v_cfg.required_main_agent_tenants,
    'min_progress', COALESCE(p_min_progress,50),
    'total', v_total,
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_service_center_qualification_candidates(numeric, integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.get_service_center_qualification_candidates(numeric, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_service_center_qualification_candidates(numeric, integer, integer) TO service_role;
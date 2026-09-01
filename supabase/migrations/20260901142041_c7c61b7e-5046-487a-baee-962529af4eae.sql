CREATE OR REPLACE FUNCTION public.get_tenant_ops_service_centre_metrics()
RETURNS TABLE (
  centre_label text,
  centre_status text,
  agents integer,
  active_tenants integer,
  total_tenants integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'tenant_ops')
    OR public.has_role(auth.uid(), 'agent_ops')
    OR public.has_role(auth.uid(), 'landlord_ops')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
  ) THEN
    RAISE EXCEPTION 'TENANT_OPS_REPORT_FORBIDDEN';
  END IF;

  RETURN QUERY
  WITH stationed AS (
    -- Agents physically stationed at a service centre entry.
    SELECT
      initcap(lower(btrim(coalesce(nullif(btrim(e.stationed_location), ''), 'Service centre')))) AS label,
      e.status::text AS status,
      a.agent_id
    FROM public.service_centre_entries e
    CROSS JOIN LATERAL unnest(coalesce(e.assigned_agent_ids, '{}'::uuid[])) AS a(agent_id)
  ),
  managers AS (
    -- Approved service centre managers run a centre in their own right.
    SELECT
      initcap(lower(btrim(coalesce(nullif(btrim(r.preferred_location), ''), nullif(btrim(r.district), ''), 'Service centre')))) AS label,
      'manager'::text AS status,
      m.agent_id
    FROM public.service_center_managers m
    LEFT JOIN public.service_center_requests r
      ON r.agent_id = m.agent_id AND r.status = 'approved'
    WHERE m.revoked_at IS NULL
  ),
  roster AS (
    SELECT label, status, agent_id FROM stationed
    UNION
    SELECT label, status, agent_id FROM managers
  ),
  -- Sub-agents of a centre agent report into the same centre.
  expanded AS (
    SELECT label, status, agent_id FROM roster
    UNION
    SELECT r.label, r.status, s.sub_agent_id
    FROM roster r
    JOIN public.agent_subagents s
      ON s.parent_agent_id = r.agent_id
     AND s.status = 'active'
     AND s.sub_agent_id IS NOT NULL
  ),
  -- One centre per agent (first alphabetically) so nobody is double counted.
  deduped AS (
    SELECT DISTINCT ON (agent_id) agent_id, label, status
    FROM expanded
    ORDER BY agent_id, label
  ),
  centre_rows AS (
    SELECT
      d.label,
      min(d.status) AS status,
      count(DISTINCT d.agent_id)::integer AS agents,
      count(b.tenant_id) FILTER (WHERE b.is_active)::integer AS active_tenants,
      count(b.tenant_id)::integer AS total_tenants
    FROM deduped d
    LEFT JOIN public.v_tenant_ops_tenant_base b ON b.agent_id = d.agent_id
    GROUP BY d.label
  ),
  unattached AS (
    SELECT
      count(DISTINCT b.agent_id)::integer AS agents,
      count(b.tenant_id) FILTER (WHERE b.is_active)::integer AS active_tenants,
      count(b.tenant_id)::integer AS total_tenants
    FROM public.v_tenant_ops_tenant_base b
    WHERE b.agent_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM deduped d WHERE d.agent_id = b.agent_id)
  )
  SELECT c.label, c.status, c.agents, c.active_tenants, c.total_tenants
  FROM centre_rows c
  UNION ALL
  SELECT 'Field agents (no service centre)', 'field', u.agents, u.active_tenants, u.total_tenants
  FROM unattached u
  WHERE u.agents > 0
  ORDER BY 4 DESC, 1;
END;
$$;

REVOKE ALL ON FUNCTION public.get_tenant_ops_service_centre_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_tenant_ops_service_centre_metrics() TO authenticated;
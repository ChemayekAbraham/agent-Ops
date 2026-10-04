CREATE OR REPLACE FUNCTION public.get_agent_ops_receivables_report()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH active AS (
  SELECT rr.id,
         rr.tenant_id,
         COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
         rr.landlord_id,
         GREATEST(COALESCE(rr.total_repayment,0) - COALESCE(rr.amount_repaid,0), 0) AS outstanding
  FROM rent_requests rr
  WHERE rr.status IN ('funded','repaying')
    AND COALESCE(rr.tenancy_status,'active') <> 'ended'
),
links AS (
  SELECT sub_agent_id, parent_agent_id
  FROM agent_subagents
  WHERE status = 'verified'
),
scm AS (
  SELECT agent_id FROM service_center_managers WHERE status = 'active'
),
per_agent AS (
  SELECT a.agent_id,
         l.parent_agent_id,
         SUM(a.outstanding) AS outstanding
  FROM active a
  LEFT JOIN links l ON l.sub_agent_id = a.agent_id
  WHERE a.agent_id IS NOT NULL
  GROUP BY a.agent_id, l.parent_agent_id
)
SELECT jsonb_build_object(
  'generated_at', now(),
  'tenants_count', (SELECT COUNT(DISTINCT tenant_id) FROM active),
  'active_plans_count', (SELECT COUNT(*) FROM active),
  'tenants_receivable', (SELECT COALESCE(SUM(outstanding),0) FROM active),
  'agents_count', (SELECT COUNT(*) FROM per_agent),
  'super_agents_count', (SELECT COUNT(*) FROM per_agent WHERE parent_agent_id IS NULL),
  'sub_agents_count', (SELECT COUNT(*) FROM per_agent WHERE parent_agent_id IS NOT NULL),
  'agents_receivable', (SELECT COALESCE(SUM(outstanding),0) FROM per_agent),
  'super_agents_receivable', (SELECT COALESCE(SUM(outstanding),0) FROM per_agent WHERE parent_agent_id IS NULL),
  'sub_agents_receivable', (SELECT COALESCE(SUM(outstanding),0) FROM per_agent WHERE parent_agent_id IS NOT NULL),
  'service_centers_total', (SELECT COUNT(*) FROM scm),
  'service_centers_count', (
    SELECT COUNT(DISTINCT s.agent_id) FROM scm s
    WHERE EXISTS (
      SELECT 1 FROM per_agent p
      WHERE p.agent_id = s.agent_id OR p.parent_agent_id = s.agent_id
    )
  ),
  'service_centers_receivable', (
    SELECT COALESCE(SUM(p.outstanding),0)
    FROM per_agent p
    WHERE EXISTS (
      SELECT 1 FROM scm s
      WHERE s.agent_id = p.agent_id OR s.agent_id = p.parent_agent_id
    )
  ),
  'landlords_count', (SELECT COUNT(DISTINCT landlord_id) FROM active WHERE landlord_id IS NOT NULL),
  'landlords_receivable', (SELECT COALESCE(SUM(outstanding),0) FROM active WHERE landlord_id IS NOT NULL)
)
$$;

REVOKE ALL ON FUNCTION public.get_agent_ops_receivables_report() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agent_ops_receivables_report() TO authenticated, service_role;
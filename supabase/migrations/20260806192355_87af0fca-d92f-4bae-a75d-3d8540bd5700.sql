CREATE OR REPLACE FUNCTION public.get_agent_ops_receivables_report()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH active AS (
  SELECT rr.id,
         rr.tenant_id,
         COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
         rr.landlord_id,
         COALESCE(rr.total_repayment,0) AS total_repayment,
         COALESCE(rr.amount_repaid,0) AS amount_repaid,
         COALESCE(rr.daily_repayment,0) AS daily_repayment,
         rr.status,
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
         COUNT(*) AS plans,
         COUNT(DISTINCT a.tenant_id) AS tenants,
         SUM(a.outstanding) AS outstanding,
         SUM(a.total_repayment) AS billed,
         SUM(a.amount_repaid) AS repaid,
         SUM(a.daily_repayment) AS daily_expected
  FROM active a
  LEFT JOIN links l ON l.sub_agent_id = a.agent_id
  WHERE a.agent_id IS NOT NULL
  GROUP BY a.agent_id, l.parent_agent_id
),
per_landlord AS (
  SELECT a.landlord_id,
         COUNT(*) AS plans,
         SUM(a.outstanding) AS outstanding,
         SUM(a.total_repayment) AS billed,
         SUM(a.amount_repaid) AS repaid
  FROM active a
  WHERE a.landlord_id IS NOT NULL
  GROUP BY a.landlord_id
),
per_scm AS (
  SELECT s.agent_id,
         SUM(p.outstanding) AS outstanding,
         SUM(p.tenants) AS tenants,
         SUM(p.billed) AS billed,
         SUM(p.repaid) AS repaid
  FROM scm s
  JOIN per_agent p ON p.agent_id = s.agent_id OR p.parent_agent_id = s.agent_id
  GROUP BY s.agent_id
)
SELECT jsonb_build_object(
  'generated_at', now(),
  'tenants_count', (SELECT COUNT(DISTINCT tenant_id) FROM active),
  'active_plans_count', (SELECT COUNT(*) FROM active),
  'tenants_receivable', (SELECT COALESCE(SUM(outstanding),0) FROM active),
  'portfolio_billed', (SELECT COALESCE(SUM(total_repayment),0) FROM active),
  'portfolio_repaid', (SELECT COALESCE(SUM(amount_repaid),0) FROM active),
  'daily_expected', (SELECT COALESCE(SUM(daily_repayment),0) FROM active),
  'plans_funded', (SELECT COUNT(*) FROM active WHERE status='funded'),
  'plans_repaying', (SELECT COUNT(*) FROM active WHERE status='repaying'),
  'plans_not_started', (SELECT COUNT(*) FROM active WHERE amount_repaid = 0),
  'plans_cleared', (SELECT COUNT(*) FROM active WHERE outstanding = 0),
  'agents_count', (SELECT COUNT(*) FROM per_agent),
  'super_agents_count', (SELECT COUNT(*) FROM per_agent WHERE parent_agent_id IS NULL),
  'sub_agents_count', (SELECT COUNT(*) FROM per_agent WHERE parent_agent_id IS NOT NULL),
  'agents_receivable', (SELECT COALESCE(SUM(outstanding),0) FROM per_agent),
  'super_agents_receivable', (SELECT COALESCE(SUM(outstanding),0) FROM per_agent WHERE parent_agent_id IS NULL),
  'sub_agents_receivable', (SELECT COALESCE(SUM(outstanding),0) FROM per_agent WHERE parent_agent_id IS NOT NULL),
  'service_centers_total', (SELECT COUNT(*) FROM scm),
  'service_centers_count', (SELECT COUNT(*) FROM per_scm),
  'service_centers_receivable', (SELECT COALESCE(SUM(outstanding),0) FROM per_scm),
  'landlords_count', (SELECT COUNT(*) FROM per_landlord),
  'landlords_receivable', (SELECT COALESCE(SUM(outstanding),0) FROM per_landlord),
  'bands', (
    SELECT COALESCE(jsonb_agg(x ORDER BY x->>'sort'), '[]'::jsonb) FROM (
      SELECT jsonb_build_object('sort', b.sort, 'label', b.label, 'plans', COUNT(a.id), 'outstanding', COALESCE(SUM(a.outstanding),0)) AS x
      FROM (VALUES
        (1, 'Cleared (0)', 0::numeric, 0::numeric),
        (2, 'Under 250k', 0.01, 250000),
        (3, '250k - 500k', 250000.01, 500000),
        (4, '500k - 1M', 500000.01, 1000000),
        (5, 'Over 1M', 1000000.01, 999999999999)
      ) AS b(sort, label, lo, hi)
      LEFT JOIN active a ON a.outstanding >= b.lo AND a.outstanding <= b.hi
      GROUP BY b.sort, b.label
    ) s
  ),
  'top_agents', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'name', COALESCE(NULLIF(pr.full_name,''), 'Agent'),
      'phone', pr.phone,
      'kind', CASE WHEN p.parent_agent_id IS NULL THEN 'Super' ELSE 'Sub' END,
      'tenants', p.tenants,
      'outstanding', p.outstanding,
      'repaid', p.repaid,
      'billed', p.billed
    ) ORDER BY p.outstanding DESC), '[]'::jsonb)
    FROM (SELECT * FROM per_agent ORDER BY outstanding DESC LIMIT 12) p
    LEFT JOIN profiles pr ON pr.id = p.agent_id
  ),
  'top_service_centers', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'name', COALESCE(NULLIF(pr.full_name,''), 'Service centre'),
      'phone', pr.phone,
      'tenants', s.tenants,
      'outstanding', s.outstanding,
      'repaid', s.repaid,
      'billed', s.billed
    ) ORDER BY s.outstanding DESC), '[]'::jsonb)
    FROM (SELECT * FROM per_scm ORDER BY outstanding DESC LIMIT 8) s
    LEFT JOIN profiles pr ON pr.id = s.agent_id
  ),
  'top_landlords', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'name', COALESCE(NULLIF(ld.name,''), NULLIF(pr.full_name,''), 'Landlord'),
      'phone', COALESCE(ld.phone, pr.phone),
      'plans', l.plans,
      'outstanding', l.outstanding,
      'repaid', l.repaid,
      'billed', l.billed
    ) ORDER BY l.outstanding DESC), '[]'::jsonb)
    FROM (SELECT * FROM per_landlord ORDER BY outstanding DESC LIMIT 8) l
    LEFT JOIN landlords ld ON ld.id = l.landlord_id
    LEFT JOIN profiles pr ON pr.id = l.landlord_id
  )
)
$function$;
CREATE OR REPLACE FUNCTION public.budget_can_access_department(_department_id uuid, _user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM operations_departments od
      JOIN hr_departments d ON lower(d.key) = lower(od.department)
     WHERE d.id = _department_id
       AND d.active
       AND od.user_id = _user_id
  )
  OR EXISTS (
    SELECT 1
      FROM staff_permissions sp
      JOIN hr_departments d ON d.id = _department_id
     WHERE sp.user_id = _user_id
       AND sp.revoked_at IS NULL
       AND d.active
       AND lower(d.key) = ANY (
         CASE lower(sp.permitted_dashboard)
           WHEN 'tenant-ops' THEN ARRAY['tenant_ops']
           WHEN 'agent-ops' THEN ARRAY['agent_ops']
           WHEN 'landlord-ops' THEN ARRAY['landlord_ops']
           WHEN 'partner-ops' THEN ARRAY['partner_ops']
           WHEN 'partners-ops' THEN ARRAY['partner_ops']
           WHEN 'cfo' THEN ARRAY['finance']
           WHEN 'financial-ops' THEN ARRAY['finance']
           WHEN 'cmo' THEN ARRAY['marketing']
           WHEN 'cto' THEN ARRAY['engineering','product_research_and_development']
           WHEN 'coo' THEN ARRAY['operations']
           WHEN 'company-ops' THEN ARRAY['operations']
           WHEN 'ceo' THEN ARRAY['board_of_directors']
           WHEN 'director' THEN ARRAY['board_of_directors']
           WHEN 'hr' THEN ARRAY['interns','support_and_welfare']
           WHEN 'crm' THEN ARRAY['partnership']
           ELSE ARRAY[]::text[]
         END
       )
  );
$$;

REVOKE ALL ON FUNCTION public.budget_can_access_department(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.budget_can_access_department(uuid, uuid) TO authenticated, service_role;
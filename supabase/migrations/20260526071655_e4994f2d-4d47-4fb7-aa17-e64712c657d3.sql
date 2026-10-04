
-- 1. agent_landlord_assignments: tighten INSERT
DROP POLICY IF EXISTS "System insert assignments" ON public.agent_landlord_assignments;
CREATE POLICY "Staff insert assignments"
  ON public.agent_landlord_assignments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role = ANY (ARRAY['manager'::app_role,'operations'::app_role,'cfo'::app_role,'coo'::app_role,'super_admin'::app_role])
    )
  );

-- 2. credit_access_draws: tighten INSERT/UPDATE
DROP POLICY IF EXISTS "System insert draws" ON public.credit_access_draws;
DROP POLICY IF EXISTS "System update draws" ON public.credit_access_draws;
CREATE POLICY "Staff insert draws"
  ON public.credit_access_draws
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role = ANY (ARRAY['manager'::app_role,'coo'::app_role,'cfo'::app_role,'super_admin'::app_role])
    )
  );
CREATE POLICY "Staff update draws"
  ON public.credit_access_draws
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role = ANY (ARRAY['manager'::app_role,'coo'::app_role,'cfo'::app_role,'super_admin'::app_role])
    )
  );

-- 3. is_tenant_ops_staff: add enabled = true
CREATE OR REPLACE FUNCTION public.is_tenant_ops_staff(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _uid
      AND enabled = true
      AND role IN ('manager','operations','coo','super_admin','ceo','cfo','cto','cmo','crm','employee','hr')
  );
$function$;

-- 4. portfolio_renewals: scope SELECT
DROP POLICY IF EXISTS "Authenticated users can read renewals" ON public.portfolio_renewals;
CREATE POLICY "Scoped read renewals"
  ON public.portfolio_renewals
  FOR SELECT
  TO authenticated
  USING (
    renewed_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.investor_portfolios ip
      WHERE ip.id = portfolio_renewals.portfolio_id
        AND (ip.investor_id = auth.uid() OR ip.agent_id = auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role = ANY (ARRAY['manager'::app_role,'operations'::app_role,'coo'::app_role,'cfo'::app_role,'ceo'::app_role,'super_admin'::app_role])
    )
  );

-- 5. vendors: hide PIN columns from anon/authenticated (service role still reads them)
REVOKE SELECT (pin, pin_hash) ON public.vendors FROM anon, authenticated;

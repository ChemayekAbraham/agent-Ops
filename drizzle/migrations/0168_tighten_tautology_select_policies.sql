-- Security: three SELECT policies allowed every signed-in user to read every row.
-- Each is replaced with a real predicate that keeps the screens that use the
-- table working.

-- Advance fee configuration is finance/executive data: only the roles that read
-- it in the CFO screens (and staff automations via SECURITY DEFINER) may see it.
DROP POLICY IF EXISTS "Authenticated users can view fee config" ON public.advance_fee_config;
CREATE POLICY "Finance roles can view fee config" ON public.advance_fee_config
  FOR SELECT TO authenticated
  USING (
    has_role(auth.uid(), 'cfo')
    OR has_role(auth.uid(), 'ceo')
    OR has_role(auth.uid(), 'coo')
    OR has_role(auth.uid(), 'financial_ops')
    OR has_role(auth.uid(), 'super_admin')
  );

-- Budget routing is internal staff data.
DROP POLICY IF EXISTS "Staff can view budget routes" ON public.budget_department_routes;
CREATE POLICY "Staff can view budget routes" ON public.budget_department_routes
  FOR SELECT TO authenticated
  USING (
    is_welile_staff(auth.uid())
    OR is_budget_reviewer(auth.uid())
    OR has_role(auth.uid(), 'super_admin')
  );

-- Landlord agreement text must stay readable to anyone signing an agreement,
-- but only the version currently in force — retired drafts are staff-only.
DROP POLICY IF EXISTS "Authenticated users can view landlord agreement versions" ON public.landlord_agreement_versions;
CREATE POLICY "Signed-in users can view the live landlord agreement" ON public.landlord_agreement_versions
  FOR SELECT TO authenticated
  USING (
    retired_at IS NULL
    OR is_welile_staff(auth.uid())
    OR has_role(auth.uid(), 'super_admin')
  );

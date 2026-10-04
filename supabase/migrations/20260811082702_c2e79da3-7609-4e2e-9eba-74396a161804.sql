-- Allow Partner Ops / manager staff to see the promissory notes queue
DROP POLICY IF EXISTS "Admin roles can view all promissory notes" ON public.promissory_notes;
CREATE POLICY "Admin roles can view all promissory notes"
ON public.promissory_notes
FOR SELECT
TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.user_roles
  WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = ANY (ARRAY['operations'::app_role,'cfo'::app_role,'coo'::app_role,'super_admin'::app_role,'manager'::app_role,'partner_ops'::app_role])
));

-- Allow Partner Ops / manager staff to approve (update) promissory notes
DROP POLICY IF EXISTS "Admin roles can update promissory notes" ON public.promissory_notes;
CREATE POLICY "Admin roles can update promissory notes"
ON public.promissory_notes
FOR UPDATE
TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.user_roles
  WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = ANY (ARRAY['operations'::app_role,'cfo'::app_role,'coo'::app_role,'super_admin'::app_role,'manager'::app_role,'partner_ops'::app_role])
));

-- Lead assignment: previously CEO/COO/super_admin only, which made the
-- whole approval fail for Partner Ops / manager staff who picked a lead.
DROP POLICY IF EXISTS pla_insert ON public.partner_lead_assignments;
CREATE POLICY pla_insert
ON public.partner_lead_assignments
FOR INSERT
TO authenticated
WITH CHECK (
  has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'partner_ops'::app_role)
);

DROP POLICY IF EXISTS pla_select ON public.partner_lead_assignments;
CREATE POLICY pla_select
ON public.partner_lead_assignments
FOR SELECT
TO authenticated
USING (
  lead_user_id = auth.uid()
  OR agent_id = auth.uid()
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'hr'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'partner_ops'::app_role)
);
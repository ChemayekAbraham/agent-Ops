DROP POLICY IF EXISTS "Ops and executives can view proxy assignments" ON public.proxy_agent_assignments;
CREATE POLICY "Ops and executives can view proxy assignments"
ON public.proxy_agent_assignments
FOR SELECT
TO authenticated
USING (
  beneficiary_id = auth.uid()
  OR agent_id = auth.uid()
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'partner_ops'::app_role)
  OR has_role(auth.uid(), 'financial_ops'::app_role)
  OR has_role(auth.uid(), 'agent_ops'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
);
CREATE POLICY "Ops staff and executives can view advances"
ON public.agent_advances
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR EXISTS (
    SELECT 1 FROM public.staff_permissions sp
    WHERE sp.user_id = auth.uid()
      AND sp.permitted_dashboard = ANY (ARRAY['agent-ops','tenant-ops','landlord-ops','financial-ops','company-ops'])
  )
);
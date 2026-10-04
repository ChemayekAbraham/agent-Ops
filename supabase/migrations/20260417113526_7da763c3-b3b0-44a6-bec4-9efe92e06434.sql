DROP POLICY IF EXISTS "Ops and executives can update advance requests" ON public.agent_advance_requests;
DROP POLICY IF EXISTS "Ops and executives can view all advance requests" ON public.agent_advance_requests;

CREATE POLICY "Ops staff and executives can view advance requests"
  ON public.agent_advance_requests FOR SELECT
  USING (
    has_role(auth.uid(),'super_admin'::app_role)
    OR has_role(auth.uid(),'manager'::app_role)
    OR has_role(auth.uid(),'cfo'::app_role)
    OR has_role(auth.uid(),'coo'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.staff_permissions sp
      WHERE sp.user_id = auth.uid()
        AND sp.permitted_dashboard IN ('agent-ops','tenant-ops','landlord-ops','financial-ops','company-ops')
    )
  );

CREATE POLICY "Ops staff and executives can update advance requests"
  ON public.agent_advance_requests FOR UPDATE
  USING (
    has_role(auth.uid(),'super_admin'::app_role)
    OR has_role(auth.uid(),'manager'::app_role)
    OR has_role(auth.uid(),'cfo'::app_role)
    OR has_role(auth.uid(),'coo'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.staff_permissions sp
      WHERE sp.user_id = auth.uid()
        AND sp.permitted_dashboard IN ('agent-ops','tenant-ops','landlord-ops','financial-ops','company-ops')
    )
  );
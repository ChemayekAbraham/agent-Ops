-- Allow ops staff & executives to view agent advance repayment ledger + topups
-- (previously restricted to managers only). Mirrors the read access already
-- granted on agent_advances so Agent Ops can trace repayments.

CREATE POLICY "Ops staff and executives can view advance ledger"
ON public.agent_advance_ledger
FOR SELECT
TO authenticated
USING (
  public.is_ops_role(auth.uid())
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR EXISTS (
    SELECT 1 FROM public.staff_permissions sp
    WHERE sp.user_id = auth.uid()
      AND sp.permitted_dashboard = ANY (ARRAY['agent-ops','tenant-ops','landlord-ops','financial-ops','company-ops'])
  )
);

CREATE POLICY "Ops staff and executives can view advance topups"
ON public.agent_advance_topups
FOR SELECT
TO authenticated
USING (
  public.is_ops_role(auth.uid())
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR EXISTS (
    SELECT 1 FROM public.staff_permissions sp
    WHERE sp.user_id = auth.uid()
      AND sp.permitted_dashboard = ANY (ARRAY['agent-ops','tenant-ops','landlord-ops','financial-ops','company-ops'])
  )
);
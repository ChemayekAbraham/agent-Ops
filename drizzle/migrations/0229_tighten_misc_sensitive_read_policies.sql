DROP POLICY IF EXISTS "Authenticated can read tier mapping" ON public.agent_tier_capabilities;
CREATE POLICY "Agent ops leaders can read tier mapping"
ON public.agent_tier_capabilities
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::public.app_role)
  OR public.has_role(auth.uid(), 'coo'::public.app_role)
  OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
);

DROP POLICY IF EXISTS hr_pos_read ON public.hr_positions;
CREATE POLICY hr_pos_read
ON public.hr_positions
FOR SELECT
TO authenticated
USING (
  public.hr_my_staff_id() IS NOT NULL
  OR public.hr_is_admin()
  OR public.hr_is_executive()
  OR public.hr_pay_is_preparer()
  OR public.hr_pay_is_approver()
  OR public.hr_pay_is_releaser()
  OR public.hr_pay_is_rule_admin()
);

DROP POLICY IF EXISTS "Authenticated can read proxy PV targets" ON public.proxy_pv_targets;
CREATE POLICY "Proxy performance viewers can read proxy PV targets"
ON public.proxy_pv_targets
FOR SELECT
TO authenticated
USING (
  public.is_proxy_directory_viewer(auth.uid())
  OR public.is_approved_proxy_agent(auth.uid())
);
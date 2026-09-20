DROP POLICY IF EXISTS "hr_dept_read" ON public.hr_departments;
CREATE POLICY "Relevant staff can read HR departments"
ON public.hr_departments
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

DROP POLICY IF EXISTS "Authenticated can read CFO approver allowlist" ON public.cfo_approval_approvers;
CREATE POLICY "Finance staff can read CFO approver allowlist"
ON public.cfo_approval_approvers
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  OR public.has_role(auth.uid(), 'cfo'::public.app_role)
  OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
  OR public.has_role(auth.uid(), 'cto'::public.app_role)
);

DROP POLICY IF EXISTS "cc_filter_buckets readable by authenticated" ON public.cc_filter_buckets;
CREATE POLICY "Calling staff can read filter buckets"
ON public.cc_filter_buckets
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'hr'::public.app_role)
  OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  OR public.has_role(auth.uid(), 'coo'::public.app_role)
  OR public.has_role(auth.uid(), 'operations'::public.app_role)
  OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
  OR public.has_role(auth.uid(), 'tenant_ops'::public.app_role)
  OR public.has_role(auth.uid(), 'landlord_ops'::public.app_role)
  OR public.has_role(auth.uid(), 'agent_ops'::public.app_role)
);
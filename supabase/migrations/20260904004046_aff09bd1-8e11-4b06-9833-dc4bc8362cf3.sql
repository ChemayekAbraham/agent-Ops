DROP POLICY IF EXISTS tenant_ops_select_reports ON public.tppo_reports;
CREATE POLICY tenant_ops_select_reports ON public.tppo_reports
FOR SELECT TO authenticated
USING (
  has_role(auth.uid(), 'tenant_ops'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'hr'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
);

DROP POLICY IF EXISTS tenant_ops_select_report_notes ON public.tppo_report_notes;
CREATE POLICY tenant_ops_select_report_notes ON public.tppo_report_notes
FOR SELECT TO authenticated
USING (
  has_role(auth.uid(), 'tenant_ops'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'hr'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
);

DROP POLICY IF EXISTS tenant_ops_select_report_actions ON public.tppo_report_actions;
CREATE POLICY tenant_ops_select_report_actions ON public.tppo_report_actions
FOR SELECT TO authenticated
USING (
  has_role(auth.uid(), 'tenant_ops'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'hr'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
);
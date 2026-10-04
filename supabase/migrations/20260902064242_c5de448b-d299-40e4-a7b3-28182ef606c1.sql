-- Drop existing SELECT policies on the four TPPO tables
DROP POLICY IF EXISTS tenant_ops_select_period_snapshots ON public.tppo_period_snapshots;
DROP POLICY IF EXISTS tenant_ops_select_reports ON public.tppo_reports;
DROP POLICY IF EXISTS tenant_ops_select_report_notes ON public.tppo_report_notes;
DROP POLICY IF EXISTS tenant_ops_select_report_actions ON public.tppo_report_actions;

-- Recreate SELECT policies widened to match the operations route guard
CREATE POLICY "tenant_ops_select_period_snapshots"
ON public.tppo_period_snapshots
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'tenant_ops'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'cmo'::app_role)
  OR has_role(auth.uid(), 'crm'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'employee'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'agent'::app_role)
  OR has_role(auth.uid(), 'hr'::app_role)
);

CREATE POLICY "tenant_ops_select_reports"
ON public.tppo_reports
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'tenant_ops'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'cmo'::app_role)
  OR has_role(auth.uid(), 'crm'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'employee'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'agent'::app_role)
  OR has_role(auth.uid(), 'hr'::app_role)
);

CREATE POLICY "tenant_ops_select_report_notes"
ON public.tppo_report_notes
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'tenant_ops'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'cmo'::app_role)
  OR has_role(auth.uid(), 'crm'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'employee'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'agent'::app_role)
  OR has_role(auth.uid(), 'hr'::app_role)
);

CREATE POLICY "tenant_ops_select_report_actions"
ON public.tppo_report_actions
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'tenant_ops'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'cmo'::app_role)
  OR has_role(auth.uid(), 'crm'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'employee'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'agent'::app_role)
  OR has_role(auth.uid(), 'hr'::app_role)
);
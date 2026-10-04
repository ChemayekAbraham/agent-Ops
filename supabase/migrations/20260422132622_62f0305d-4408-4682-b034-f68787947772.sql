-- Allow executive/ops staff to read agent_collections for reporting
CREATE POLICY "Staff can view all agent_collections"
  ON public.agent_collections FOR SELECT
  USING (
    has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'ceo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'operations'::app_role)
  );

-- Allow executive/ops staff to read repayments for reporting
CREATE POLICY "Staff can view all repayments"
  ON public.repayments FOR SELECT
  USING (
    has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'ceo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'operations'::app_role)
  );
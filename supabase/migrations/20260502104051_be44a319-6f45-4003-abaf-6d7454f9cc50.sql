-- Profiles: allow ops/exec/employee read access for ops dashboards (Pending Review, etc.)
CREATE POLICY "Ops and executives can view all profiles"
ON public.profiles FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'cmo'::app_role)
  OR has_role(auth.uid(), 'crm'::app_role)
  OR has_role(auth.uid(), 'employee'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
);

-- Landlords: add employee read access (operations/coo/ceo/cfo/cto/super_admin already covered)
CREATE POLICY "Employees can view all landlords for ops"
ON public.landlords FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'employee'::app_role));

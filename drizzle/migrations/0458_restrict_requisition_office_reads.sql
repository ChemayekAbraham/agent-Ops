DROP POLICY IF EXISTS "Authenticated read requisition offices" ON public.staff_requisition_offices;
CREATE POLICY "HR, admins and holders read requisition offices" ON public.staff_requisition_offices
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'hr'::app_role)
    OR EXISTS (SELECT 1 FROM public.staff_requisition_offices o WHERE o.holder_id = auth.uid())
  );
DROP POLICY IF EXISTS "Authenticated read requisition office history" ON public.staff_requisition_office_history;
CREATE OR REPLACE FUNCTION public.is_requisition_office_holder(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.staff_requisition_offices WHERE holder_id = _uid) $$;
DROP POLICY IF EXISTS "HR, admins and holders read requisition offices" ON public.staff_requisition_offices;
CREATE POLICY "HR, admins and holders read requisition offices" ON public.staff_requisition_offices
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'hr'::app_role)
    OR public.is_requisition_office_holder(auth.uid())
  );
CREATE POLICY "HR, admins and holders read requisition office history" ON public.staff_requisition_office_history
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'hr'::app_role)
    OR public.is_requisition_office_holder(auth.uid())
  );
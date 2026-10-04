DROP POLICY IF EXISTS "Admin roles can view all promissory notes" ON public.promissory_notes;
CREATE POLICY "Admin roles can view all promissory notes"
ON public.promissory_notes FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.user_roles
  WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = ANY (ARRAY['operations'::app_role,'cfo'::app_role,'coo'::app_role,'super_admin'::app_role,'manager'::app_role,'partner_ops'::app_role,'agent_ops'::app_role])
));

DROP POLICY IF EXISTS "Admin roles can update promissory notes" ON public.promissory_notes;
CREATE POLICY "Admin roles can update promissory notes"
ON public.promissory_notes FOR UPDATE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.user_roles
  WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = ANY (ARRAY['operations'::app_role,'cfo'::app_role,'coo'::app_role,'super_admin'::app_role,'manager'::app_role,'partner_ops'::app_role,'agent_ops'::app_role])
));
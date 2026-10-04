ALTER POLICY "Users can view roles"
ON public.user_roles
USING (
  auth.uid() = user_id
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
);
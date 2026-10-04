
DROP POLICY IF EXISTS "Users can view own role" ON public.user_roles;

CREATE POLICY "Users can view roles"
ON public.user_roles
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'cto')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'cmo')
  OR public.has_role(auth.uid(), 'crm')
);

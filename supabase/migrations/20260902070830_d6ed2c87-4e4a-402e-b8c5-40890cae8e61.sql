-- Remove plaintext PIN column from vendors
ALTER TABLE public.vendors DROP COLUMN IF EXISTS pin;

-- Replace the permissive SELECT policy with one limited to ops/manager/super-admin roles
DROP POLICY IF EXISTS "Authenticated users can view active vendors" ON public.vendors;
CREATE POLICY "Managers and operations can view vendors" ON public.vendors
  FOR SELECT TO authenticated
  USING (
    has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'operations'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
  );

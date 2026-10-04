-- Drop the existing restrictive insert policy
DROP POLICY IF EXISTS "Users can insert own roles" ON public.user_roles;

-- Create a new policy that allows managers to insert roles for any user
CREATE POLICY "Users or managers can insert roles" 
ON public.user_roles 
FOR INSERT 
TO authenticated
WITH CHECK (
  auth.uid() = user_id 
  OR has_role(auth.uid(), 'manager'::app_role)
);

-- Also add UPDATE and DELETE policies for managers
DROP POLICY IF EXISTS "Managers can update roles" ON public.user_roles;
CREATE POLICY "Managers can update roles" 
ON public.user_roles 
FOR UPDATE 
TO authenticated
USING (has_role(auth.uid(), 'manager'::app_role))
WITH CHECK (has_role(auth.uid(), 'manager'::app_role));

DROP POLICY IF EXISTS "Managers can delete roles" ON public.user_roles;
CREATE POLICY "Managers can delete roles" 
ON public.user_roles 
FOR DELETE 
TO authenticated
USING (has_role(auth.uid(), 'manager'::app_role));
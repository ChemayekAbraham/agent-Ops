-- Drop and recreate supporter SELECT policy with a simpler approach
DROP POLICY IF EXISTS "Supporters view all rent requests" ON public.rent_requests;

-- Create a policy that allows any authenticated user with supporter role to view all rent requests
CREATE POLICY "Supporters view all rent requests" 
ON public.rent_requests 
FOR SELECT 
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE user_roles.user_id = auth.uid() 
    AND user_roles.role = 'supporter' 
    AND user_roles.enabled = true
  )
);
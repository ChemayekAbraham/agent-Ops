-- Allow the rent_requests RLS policy to read from user_roles
-- Create a SECURITY DEFINER function specifically for checking supporter role
CREATE OR REPLACE FUNCTION public.is_supporter()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'supporter' AND enabled = true
  )
$function$;

-- Drop and recreate with the new function
DROP POLICY IF EXISTS "Supporters view all rent requests" ON public.rent_requests;

CREATE POLICY "Supporters view all rent requests" 
ON public.rent_requests 
FOR SELECT 
TO authenticated
USING (public.is_supporter());
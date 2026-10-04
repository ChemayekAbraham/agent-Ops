-- Drop and recreate the supporter SELECT policy to ensure it works for ALL statuses
DROP POLICY IF EXISTS "Supporters view all rent requests" ON public.rent_requests;

CREATE POLICY "Supporters view all rent requests" 
ON public.rent_requests 
FOR SELECT 
USING (has_role(auth.uid(), 'supporter'::app_role));
-- Drop existing supporter policy
DROP POLICY IF EXISTS "Supporters view opportunities and funded requests" ON public.rent_requests;

-- Create new policy: Supporters can see ALL rent requests (like managers)
CREATE POLICY "Supporters view all rent requests"
ON public.rent_requests
FOR SELECT
USING (
  has_role(auth.uid(), 'supporter'::app_role)
);
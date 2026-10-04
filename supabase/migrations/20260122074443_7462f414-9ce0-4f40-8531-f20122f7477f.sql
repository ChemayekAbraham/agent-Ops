-- Drop the existing restrictive policy
DROP POLICY IF EXISTS "Supporters view funded/available requests" ON public.rent_requests;

-- Create new policy that allows supporters to see pending, approved, and their funded requests
CREATE POLICY "Supporters view opportunities and funded requests"
ON public.rent_requests
FOR SELECT
USING (
  has_role(auth.uid(), 'supporter'::app_role) 
  AND (
    status IN ('pending', 'approved') 
    OR supporter_id = auth.uid()
  )
);
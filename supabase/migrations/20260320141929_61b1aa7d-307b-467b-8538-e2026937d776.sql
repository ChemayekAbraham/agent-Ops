
-- Drop the old restrictive policies and replace with ones that allow any authenticated user to see unverified requests
DROP POLICY IF EXISTS "Agents view unverified requests for verification" ON public.rent_requests;
DROP POLICY IF EXISTS "Agents can verify any unverified request" ON public.rent_requests;

-- Allow any authenticated user to see unverified rent requests for verification
CREATE POLICY "Authenticated view unverified requests for verification"
ON public.rent_requests
FOR SELECT
TO authenticated
USING (
  agent_verified = false
  AND status IN ('pending', 'approved')
);

-- Allow any authenticated user to update verification fields on unverified requests
CREATE POLICY "Authenticated can verify unverified requests"
ON public.rent_requests
FOR UPDATE
TO authenticated
USING (
  agent_verified = false
  AND status IN ('pending', 'approved')
)
WITH CHECK (true);

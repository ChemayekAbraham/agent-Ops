
-- Allow any agent to see unverified rent requests (for verification opportunities)
CREATE POLICY "Agents view unverified requests for verification"
ON public.rent_requests
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'agent'::app_role)
  AND agent_verified = false
  AND status IN ('pending', 'approved')
);

-- Allow any agent to update verification fields on unverified requests
CREATE POLICY "Agents can verify any unverified request"
ON public.rent_requests
FOR UPDATE
TO authenticated
USING (
  has_role(auth.uid(), 'agent'::app_role)
  AND agent_verified = false
  AND status IN ('pending', 'approved')
)
WITH CHECK (
  has_role(auth.uid(), 'agent'::app_role)
);


-- Drop the old agent SELECT policy and replace with one that also covers unverified rent requests
DROP POLICY IF EXISTS "Agents can view managed profiles" ON public.profiles;

CREATE POLICY "Agents can view managed profiles"
ON public.profiles FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'agent'::app_role)
  AND (
    referrer_id = auth.uid()
    OR id IN (
      SELECT rr.tenant_id FROM rent_requests rr WHERE rr.agent_id = auth.uid()
    )
    OR id IN (
      SELECT rr.tenant_id FROM rent_requests rr
      WHERE rr.agent_verified = false
      AND rr.status IN ('pending', 'approved')
    )
  )
);

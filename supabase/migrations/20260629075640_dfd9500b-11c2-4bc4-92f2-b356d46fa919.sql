
DROP POLICY IF EXISTS "Agents can view managed profiles" ON public.profiles;

CREATE POLICY "Agents can view managed profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  -- Direct ownership links: scoped to the requesting user's OWN tenants,
  -- so they are safe to allow even for staff acting as agents who do not
  -- hold the literal 'agent' role.
  id IN (
    SELECT rr.tenant_id FROM public.rent_requests rr
    WHERE rr.agent_id = auth.uid()
  )
  OR id IN (
    SELECT r.referred_id FROM public.referrals r
    WHERE r.referrer_id = auth.uid()
  )
  -- Referrer field + the broad "unverified pending request" verification
  -- queue remain gated behind the agent role.
  OR (
    has_role(auth.uid(), 'agent'::app_role)
    AND (
      referrer_id = auth.uid()
      OR id IN (
        SELECT rr.tenant_id FROM public.rent_requests rr
        WHERE rr.agent_verified = false
          AND rr.status = ANY (ARRAY['pending'::text, 'approved'::text])
      )
    )
  )
);

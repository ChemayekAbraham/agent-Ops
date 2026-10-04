-- Allow agents to edit their tenants' profiles (including name) without manager approval.
-- Previously the agent UPDATE policy was narrower than the agent SELECT policy, so some
-- tenants the agent could see could not be edited, triggering the "Manager Approval Required" block.
-- Field-level locks (verified, role, monthly_rent, etc.) remain enforced by trg_restrict_agent_profile_edits,
-- and evicted-tenant identity remains locked by trg_guard_evicted_tenant_identity.

DROP POLICY IF EXISTS "Agents can update managed tenant contact info" ON public.profiles;

CREATE POLICY "Agents can update managed tenant contact info"
ON public.profiles
FOR UPDATE
TO authenticated
USING (
  has_role(auth.uid(), 'agent'::app_role)
  AND (
    referrer_id = auth.uid()
    OR id IN (SELECT rr.tenant_id FROM rent_requests rr WHERE rr.agent_id = auth.uid())
    OR id IN (
      SELECT rr.tenant_id FROM rent_requests rr
      WHERE rr.agent_verified = false
        AND rr.status = ANY (ARRAY['pending'::text, 'approved'::text])
    )
    OR (managed_by_agent = true AND managing_agent_id = auth.uid())
  )
)
WITH CHECK (
  has_role(auth.uid(), 'agent'::app_role)
  AND (
    referrer_id = auth.uid()
    OR id IN (SELECT rr.tenant_id FROM rent_requests rr WHERE rr.agent_id = auth.uid())
    OR id IN (
      SELECT rr.tenant_id FROM rent_requests rr
      WHERE rr.agent_verified = false
        AND rr.status = ANY (ARRAY['pending'::text, 'approved'::text])
    )
    OR (managed_by_agent = true AND managing_agent_id = auth.uid())
  )
);
-- 1. Drop the old self-insert policy and recreate with a proxy-managed exclusion
DROP POLICY IF EXISTS "Users can create their own withdrawal requests" ON public.withdrawal_requests;

CREATE POLICY "Users can create their own withdrawal requests"
ON public.withdrawal_requests
FOR INSERT
WITH CHECK (
  auth.uid() = user_id
  -- Block self-withdrawals when the user is a proxy-managed partner.
  -- They must withdraw through their assigned proxy agent.
  AND NOT EXISTS (
    SELECT 1
    FROM public.proxy_agent_assignments paa
    WHERE paa.beneficiary_id = auth.uid()
      AND paa.is_active = true
      AND paa.approval_status = 'approved'
      AND (paa.expires_at IS NULL OR paa.expires_at > now())
  )
);

-- 2. Allow an active assigned proxy agent to insert a withdrawal request
--    for their proxy partner. user_id MUST equal the partner (legal owner of
--    the funds) and agent_id / initiated_by / proxy_partner_id must be set
--    consistently so existing triggers and edge functions debit the partner.
CREATE POLICY "Proxy agents can submit withdrawals for their partner"
ON public.withdrawal_requests
FOR INSERT
WITH CHECK (
  agent_id = auth.uid()
  AND initiated_by = auth.uid()
  AND proxy_partner_id IS NOT NULL
  AND proxy_partner_id = user_id
  AND beneficiary_id = user_id
  AND user_id <> auth.uid()
  AND EXISTS (
    SELECT 1
    FROM public.proxy_agent_assignments paa
    WHERE paa.agent_id = auth.uid()
      AND paa.beneficiary_id = withdrawal_requests.user_id
      AND paa.is_active = true
      AND paa.approval_status = 'approved'
      AND (paa.expires_at IS NULL OR paa.expires_at > now())
  )
);
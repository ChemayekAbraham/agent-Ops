-- Fix Merchant Agent UPDATE policy: assigned_cashout_agent_id stores cashout_agents.id, not auth.uid()
DROP POLICY IF EXISTS "Active merchant agents can claim or release payouts" ON public.withdrawal_requests;

CREATE POLICY "Active merchant agents can claim or release payouts"
ON public.withdrawal_requests
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.cashout_agents ca
    WHERE ca.agent_id = auth.uid()
      AND ca.is_active = true
  )
  AND status IN ('pending', 'requested', 'approved', 'manager_approved', 'cfo_approved')
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.cashout_agents ca
    WHERE ca.agent_id = auth.uid()
      AND ca.is_active = true
  )
  AND (
    -- Claiming: target row must currently be unassigned (enforced by USING in practice),
    -- and the new assignment must point to one of this user's cashout_agents rows
    assigned_cashout_agent_id IS NULL
    OR assigned_cashout_agent_id IN (
      SELECT ca.id FROM public.cashout_agents ca
      WHERE ca.agent_id = auth.uid()
        AND ca.is_active = true
    )
  )
);
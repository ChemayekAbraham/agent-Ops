-- Allow active cashout agents to UPDATE withdrawal_requests (claim + complete)
DROP POLICY IF EXISTS "Staff can update withdrawal requests" ON public.withdrawal_requests;

CREATE POLICY "Staff and cashout agents can update withdrawal requests"
ON public.withdrawal_requests
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.role IN ('manager', 'operations', 'cfo', 'coo', 'super_admin', 'cto')
  )
  OR EXISTS (
    SELECT 1 FROM cashout_agents
    WHERE cashout_agents.agent_id = auth.uid()
      AND cashout_agents.is_active = true
  )
);
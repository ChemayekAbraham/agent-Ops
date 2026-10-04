-- Drop and recreate the SELECT policy to include cashout agents
DROP POLICY IF EXISTS "Staff can view all withdrawal requests" ON public.withdrawal_requests;

CREATE POLICY "Staff and cashout agents can view withdrawal requests"
ON public.withdrawal_requests
FOR SELECT
USING (
  auth.uid() = user_id
  OR EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = ANY (ARRAY['manager'::app_role, 'operations'::app_role, 'cfo'::app_role, 'coo'::app_role, 'super_admin'::app_role, 'cto'::app_role])
  )
  OR EXISTS (
    SELECT 1 FROM cashout_agents
    WHERE cashout_agents.agent_id = auth.uid()
    AND cashout_agents.is_active = true
  )
);
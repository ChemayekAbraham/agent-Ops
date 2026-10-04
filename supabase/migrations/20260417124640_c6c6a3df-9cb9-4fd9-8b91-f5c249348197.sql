-- Align SELECT policies with the new self-assignment rule
DROP POLICY IF EXISTS "Staff and cashout agents can view withdrawal requests" ON public.withdrawal_requests;

CREATE POLICY "Staff and cashout agents can view withdrawal requests"
ON public.withdrawal_requests
FOR SELECT
USING (
  (auth.uid() = user_id)
  OR EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.role = ANY (ARRAY['manager'::app_role, 'operations'::app_role, 'cfo'::app_role, 'coo'::app_role, 'super_admin'::app_role, 'cto'::app_role])
  )
  OR EXISTS (
    SELECT 1 FROM cashout_agents ca
    WHERE ca.agent_id = auth.uid()
      AND ca.is_active = true
      AND ca.assigned_by IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM user_roles ur
        WHERE ur.user_id = ca.assigned_by
          AND ur.role IN ('cfo'::app_role, 'super_admin'::app_role, 'coo'::app_role)
      )
  )
);

DROP POLICY IF EXISTS "Cashout agents can view profiles for withdrawals" ON public.profiles;

CREATE POLICY "Cashout agents can view profiles for withdrawals"
ON public.profiles
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM cashout_agents ca
    WHERE ca.agent_id = auth.uid()
      AND ca.is_active = true
      AND ca.assigned_by IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM user_roles ur
        WHERE ur.user_id = ca.assigned_by
          AND ur.role IN ('cfo'::app_role, 'super_admin'::app_role, 'coo'::app_role)
      )
  )
  AND id IN (
    SELECT user_id FROM withdrawal_requests
    WHERE status IN ('pending', 'requested', 'manager_approved', 'cfo_approved', 'approved', 'fin_ops_approved')
  )
);
-- 1. Replace the SELECT policy with a broader status list
DROP POLICY IF EXISTS "Active merchant agents can view shared payout queue" ON public.withdrawal_requests;
DROP POLICY IF EXISTS "Staff and cashout agents can view withdrawal requests" ON public.withdrawal_requests;

CREATE POLICY "Owners staff and active merchant agents can view withdrawals"
ON public.withdrawal_requests
FOR SELECT
TO authenticated
USING (
  -- Owner can always see their own request
  auth.uid() = user_id
  -- Financial / executive staff
  OR EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND role = ANY (ARRAY['manager'::app_role, 'operations'::app_role, 'cfo'::app_role, 'coo'::app_role, 'super_admin'::app_role, 'cto'::app_role])
  )
  -- Any active Merchant Agent sees the shared queue across all active pipeline stages
  OR (
    status IN ('pending', 'requested', 'approved', 'manager_approved', 'cfo_approved')
    AND EXISTS (
      SELECT 1 FROM public.cashout_agents ca
      WHERE ca.agent_id = auth.uid()
        AND ca.is_active = true
    )
  )
);

-- 2. Tighten the UPDATE policy: agents may only touch assignment fields
DROP POLICY IF EXISTS "Staff and cashout agents can update withdrawal requests" ON public.withdrawal_requests;

-- Staff: full update rights
CREATE POLICY "Staff can update withdrawal requests"
ON public.withdrawal_requests
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND role = ANY (ARRAY['manager'::app_role, 'operations'::app_role, 'cfo'::app_role, 'coo'::app_role, 'super_admin'::app_role, 'cto'::app_role])
  )
);

-- Active Merchant Agents: may claim (null -> self) or release (self -> null) only
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
    assigned_cashout_agent_id IS NULL
    OR assigned_cashout_agent_id = auth.uid()
  )
);

-- Drop the old manager-only update policy
DROP POLICY IF EXISTS "Managers can update withdrawal requests" ON public.withdrawal_requests;

-- Create a new update policy that allows all staff roles involved in the approval pipeline
CREATE POLICY "Staff can update withdrawal requests"
ON public.withdrawal_requests
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.role IN ('manager', 'operations', 'cfo', 'coo', 'super_admin', 'cto')
  )
);

-- Also allow staff to SELECT all withdrawal requests (not just managers)
DROP POLICY IF EXISTS "Managers can view all withdrawal requests" ON public.withdrawal_requests;

CREATE POLICY "Staff can view all withdrawal requests"
ON public.withdrawal_requests
FOR SELECT
USING (
  auth.uid() = user_id
  OR EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.role IN ('manager', 'operations', 'cfo', 'coo', 'super_admin', 'cto')
  )
);

-- Drop the now-redundant user select policy (merged above)
DROP POLICY IF EXISTS "Users can view their own withdrawal requests" ON public.withdrawal_requests;

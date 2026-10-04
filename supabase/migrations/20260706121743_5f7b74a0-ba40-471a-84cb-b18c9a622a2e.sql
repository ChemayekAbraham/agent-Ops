CREATE OR REPLACE FUNCTION public.is_active_cashout_agent(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.cashout_agents ca
    WHERE ca.agent_id = _user_id
      AND ca.is_active = true
  );
$$;

CREATE OR REPLACE FUNCTION public.is_withdrawal_staff(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = _user_id
      AND ur.enabled = true
      AND ur.role IN ('manager', 'operations', 'cfo', 'coo', 'super_admin', 'cto')
  );
$$;

DROP POLICY IF EXISTS "Owners staff and active merchant agents can view withdrawals" ON public.withdrawal_requests;

CREATE POLICY "Owners staff and active merchant agents can view withdrawals"
ON public.withdrawal_requests
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
  OR public.is_withdrawal_staff(auth.uid())
  OR (
    status = ANY (ARRAY['pending'::text, 'requested'::text, 'approved'::text, 'manager_approved'::text, 'cfo_approved'::text, 'fin_ops_approved'::text])
    AND public.is_active_cashout_agent(auth.uid())
  )
);

DROP POLICY IF EXISTS "Active merchant agents can claim or release payouts" ON public.withdrawal_requests;

CREATE POLICY "Active merchant agents can claim or release payouts"
ON public.withdrawal_requests
FOR UPDATE
TO authenticated
USING (
  public.is_active_cashout_agent(auth.uid())
  AND status = ANY (ARRAY['pending'::text, 'requested'::text, 'approved'::text, 'manager_approved'::text, 'cfo_approved'::text, 'fin_ops_approved'::text])
)
WITH CHECK (
  public.is_active_cashout_agent(auth.uid())
  AND (
    assigned_cashout_agent_id IS NULL
    OR assigned_cashout_agent_id IN (
      SELECT ca.id
      FROM public.cashout_agents ca
      WHERE ca.agent_id = auth.uid()
        AND ca.is_active = true
    )
  )
);

DROP POLICY IF EXISTS "Staff can update withdrawal requests" ON public.withdrawal_requests;

CREATE POLICY "Staff can update withdrawal requests"
ON public.withdrawal_requests
FOR UPDATE
TO authenticated
USING (public.is_withdrawal_staff(auth.uid()));

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_cashout_available
ON public.withdrawal_requests (status, created_at DESC, assigned_cashout_agent_id, dispatched_at)
WHERE status IN ('pending', 'requested', 'manager_approved', 'cfo_approved', 'fin_ops_approved');
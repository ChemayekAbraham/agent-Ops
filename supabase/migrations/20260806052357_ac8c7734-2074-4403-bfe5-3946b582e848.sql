DROP POLICY IF EXISTS "Owners staff and active merchant agents can view withdrawals" ON public.withdrawal_requests;

CREATE POLICY "Owners staff and active merchant agents can view withdrawals"
ON public.withdrawal_requests
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
  OR public.is_withdrawal_staff(auth.uid())
  OR (
    status = ANY (ARRAY['pending','requested','approved','manager_approved','cfo_approved','fin_ops_approved'])
    AND public.is_active_cashout_agent(auth.uid())
  )
  OR (
    status = 'completed'
    AND public.is_active_cashout_agent(auth.uid())
    AND (
      assigned_cashout_agent_id = (
        SELECT ca.id FROM public.cashout_agents ca WHERE ca.agent_id = auth.uid() LIMIT 1
      )
      OR processed_by = auth.uid()
    )
  )
);
CREATE POLICY "Active merchant agents can view shared payout queue"
ON public.withdrawal_requests
FOR SELECT
TO authenticated
USING (
  status IN ('pending', 'approved')
  AND EXISTS (
    SELECT 1
    FROM public.cashout_agents ca
    WHERE ca.agent_id = auth.uid()
      AND ca.is_active = true
  )
);
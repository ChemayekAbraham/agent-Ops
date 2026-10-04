CREATE POLICY "Proxy initiators can view their proxy withdrawals"
ON public.withdrawal_requests
FOR SELECT
TO authenticated
USING (
  proxy_partner_id IS NOT NULL
  AND (agent_id = auth.uid() OR initiated_by = auth.uid())
);
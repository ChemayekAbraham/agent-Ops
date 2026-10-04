CREATE POLICY "Agents can view own commissions"
ON public.commission_accrual_ledger
FOR SELECT
TO authenticated
USING (agent_id = auth.uid());
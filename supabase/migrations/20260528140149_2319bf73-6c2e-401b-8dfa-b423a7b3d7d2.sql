DROP POLICY IF EXISTS "Owners and assigned agents can read payout_codes" ON public.payout_codes;

CREATE POLICY "Owners and assigned agents can read payout_codes"
ON public.payout_codes
FOR SELECT
USING (
  user_id = auth.uid()
  OR claimed_by = auth.uid()
  OR paid_by = auth.uid()
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR (
    has_role(auth.uid(), 'agent'::app_role)
    AND EXISTS (
      SELECT 1
      FROM withdrawal_requests wr
      LEFT JOIN cashout_agents ca ON ca.id = wr.assigned_cashout_agent_id
      WHERE wr.id = payout_codes.withdrawal_request_id
        AND (wr.agent_id = auth.uid() OR ca.agent_id = auth.uid())
    )
  )
);
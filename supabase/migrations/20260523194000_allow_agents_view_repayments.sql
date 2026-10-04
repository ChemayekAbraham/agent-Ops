-- Migration: Allow agents to view repayments for rent requests they registered or managed
CREATE POLICY "Agents can view repayments for their managed requests"
  ON public.repayments FOR SELECT
  USING (
    has_role(auth.uid(), 'agent'::app_role)
    AND EXISTS (
      SELECT 1 FROM public.rent_requests r
      WHERE r.id = repayments.rent_request_id
      AND r.agent_id = auth.uid()
    )
  );

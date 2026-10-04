-- Allow agents to update verification fields on their rent requests
CREATE POLICY "Agents can verify their requests"
ON public.rent_requests
FOR UPDATE
USING (has_role(auth.uid(), 'agent'::app_role) AND agent_id = auth.uid())
WITH CHECK (has_role(auth.uid(), 'agent'::app_role) AND agent_id = auth.uid());
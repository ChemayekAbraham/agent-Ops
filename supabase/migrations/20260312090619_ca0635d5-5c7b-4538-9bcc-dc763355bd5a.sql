-- Allow agents to create deposit requests on behalf of customers
CREATE POLICY "Agents can create deposit requests for customers"
ON public.deposit_requests
FOR INSERT
TO authenticated
WITH CHECK (
  agent_id = auth.uid()
);
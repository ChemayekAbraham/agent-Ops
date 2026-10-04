CREATE POLICY "CEO can view advance requests"
ON public.agent_advance_requests
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'ceo'::app_role));
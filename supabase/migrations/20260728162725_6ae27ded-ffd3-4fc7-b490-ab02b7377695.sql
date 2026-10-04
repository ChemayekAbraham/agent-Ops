CREATE POLICY "CFO and executives can create advance requests for agents"
ON public.agent_advance_requests
FOR INSERT
TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'manager')
);
CREATE POLICY "Managers can delete advances"
ON public.agent_advances
FOR DELETE
USING (public.has_role(auth.uid(), 'manager'::app_role));
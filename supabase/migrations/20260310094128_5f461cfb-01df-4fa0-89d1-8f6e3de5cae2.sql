CREATE POLICY "Managers can insert portfolios"
ON public.investor_portfolios
FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'manager'::app_role));
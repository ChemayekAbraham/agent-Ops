-- Allow managers to update investor_portfolios (e.g. ROI changes)
CREATE POLICY "Managers can update portfolios"
  ON public.investor_portfolios
  FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'manager'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'manager'::app_role));
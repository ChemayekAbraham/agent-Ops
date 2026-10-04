
DROP POLICY "Authenticated users can insert renewals" ON public.portfolio_renewals;
CREATE POLICY "Authenticated users can insert own renewals"
  ON public.portfolio_renewals FOR INSERT
  TO authenticated WITH CHECK (renewed_by = auth.uid());

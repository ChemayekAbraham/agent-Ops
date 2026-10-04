-- Allow COO to update portfolios
CREATE POLICY "COO can update portfolios"
ON public.investor_portfolios
FOR UPDATE
TO authenticated
USING (has_role(auth.uid(), 'coo'::app_role))
WITH CHECK (has_role(auth.uid(), 'coo'::app_role));

-- Allow managers to delete portfolios
CREATE POLICY "Managers can delete portfolios"
ON public.investor_portfolios
FOR DELETE
TO authenticated
USING (has_role(auth.uid(), 'manager'::app_role));

-- Allow COO to delete portfolios
CREATE POLICY "COO can delete portfolios"
ON public.investor_portfolios
FOR DELETE
TO authenticated
USING (has_role(auth.uid(), 'coo'::app_role));

-- Allow COO to select all portfolios
CREATE POLICY "COO can select all portfolios"
ON public.investor_portfolios
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'coo'::app_role));
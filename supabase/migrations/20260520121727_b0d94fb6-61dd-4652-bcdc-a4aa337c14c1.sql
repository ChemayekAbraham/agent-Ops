-- Allow Partner Ops staff (COO / operations / manager) to manage saved_payout_methods on behalf of partners
CREATE POLICY "Staff manage payout methods for any user - select"
ON public.saved_payout_methods
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'operations')
  OR public.has_role(auth.uid(), 'manager')
);

CREATE POLICY "Staff manage payout methods for any user - insert"
ON public.saved_payout_methods
FOR INSERT
TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'operations')
  OR public.has_role(auth.uid(), 'manager')
);

CREATE POLICY "Staff manage payout methods for any user - update"
ON public.saved_payout_methods
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'operations')
  OR public.has_role(auth.uid(), 'manager')
);

CREATE POLICY "Staff manage payout methods for any user - delete"
ON public.saved_payout_methods
FOR DELETE
TO authenticated
USING (
  public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'operations')
  OR public.has_role(auth.uid(), 'manager')
);

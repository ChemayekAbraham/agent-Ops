-- Allow CEO/manager to update angel pool investments
-- (used for soft-delete/suspend/edit-shares from CEO Angel Pool panel).
-- Without this UPDATE policy, the client UPDATE silently affects 0 rows
-- and the UI reports success while nothing changes.

DROP POLICY IF EXISTS "CEO can update angel investments" ON public.angel_pool_investments;
CREATE POLICY "CEO can update angel investments"
ON public.angel_pool_investments
FOR UPDATE
USING (
  public.has_role(auth.uid(), 'ceo'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
)
WITH CHECK (
  public.has_role(auth.uid(), 'ceo'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
);

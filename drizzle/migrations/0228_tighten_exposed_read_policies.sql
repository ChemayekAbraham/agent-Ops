DROP POLICY IF EXISTS "Authenticated can read wallet totals cache" ON public.wallet_totals_cache;
CREATE POLICY "Finance leaders can read wallet totals cache"
ON public.wallet_totals_cache
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo'::public.app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::public.app_role)
  OR public.has_role(auth.uid(), 'manager'::public.app_role)
  OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
  OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  OR public.has_role(auth.uid(), 'coo'::public.app_role)
  OR public.has_role(auth.uid(), 'cto'::public.app_role)
);

DROP POLICY IF EXISTS "pcr_read_staff" ON public.promissory_commission_rates;
CREATE POLICY "Finance leaders can read promissory commission rates"
ON public.promissory_commission_rates
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo'::public.app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::public.app_role)
  OR public.has_role(auth.uid(), 'manager'::public.app_role)
  OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
  OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  OR public.has_role(auth.uid(), 'coo'::public.app_role)
);

DROP POLICY IF EXISTS "Signed-in users can view redirect monitor" ON public.redirect_monitor;
CREATE POLICY "Leaders can view redirect monitor"
ON public.redirect_monitor
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::public.app_role)
  OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
  OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  OR public.has_role(auth.uid(), 'coo'::public.app_role)
  OR public.has_role(auth.uid(), 'cto'::public.app_role)
);
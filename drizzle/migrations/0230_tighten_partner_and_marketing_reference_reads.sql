DROP POLICY IF EXISTS "Authenticated can read company defaults" ON public.partner_agreement_company_defaults;
CREATE POLICY "Partner operations can read company defaults"
ON public.partner_agreement_company_defaults
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::public.app_role)
  OR public.has_role(auth.uid(), 'partner_ops'::public.app_role)
  OR public.has_role(auth.uid(), 'coo'::public.app_role)
  OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
);

DROP POLICY IF EXISTS "Authenticated staff can view brand snapshots" ON public.semrush_brand_snapshots;
CREATE POLICY "Marketing leaders can view brand snapshots"
ON public.semrush_brand_snapshots
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cmo'::public.app_role)
  OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  OR public.has_role(auth.uid(), 'coo'::public.app_role)
  OR public.has_role(auth.uid(), 'cfo'::public.app_role)
  OR public.has_role(auth.uid(), 'cto'::public.app_role)
  OR public.has_role(auth.uid(), 'manager'::public.app_role)
  OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
);

DROP POLICY IF EXISTS "pnr_select" ON public.partner_note_rates;
CREATE POLICY "Finance leaders can read partner note rates"
ON public.partner_note_rates
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'ceo'::public.app_role)
  OR public.has_role(auth.uid(), 'cfo'::public.app_role)
  OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
);
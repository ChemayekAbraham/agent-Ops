DROP POLICY IF EXISTS "Finance roles resolve proof integrity alerts" ON public.payout_proof_integrity_alerts;
CREATE POLICY "Finance roles resolve proof integrity alerts"
ON public.payout_proof_integrity_alerts
FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'super_admin')
)
WITH CHECK (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'super_admin')
);

DROP POLICY IF EXISTS "Finance staff update sender wallet bindings" ON public.email_sender_wallet_bindings;
CREATE POLICY "Finance staff update sender wallet bindings"
ON public.email_sender_wallet_bindings
FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'operations')
  OR public.has_role(auth.uid(), 'super_admin')
)
WITH CHECK (
  public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'operations')
  OR public.has_role(auth.uid(), 'super_admin')
);

DROP POLICY IF EXISTS "Signed-in users can view change of address monitor" ON public.change_of_address_monitor;
CREATE POLICY "Staff can view change of address monitor"
ON public.change_of_address_monitor
FOR SELECT TO authenticated
USING (
  public.is_welile_staff(auth.uid())
  OR public.has_role(auth.uid(), 'super_admin')
);
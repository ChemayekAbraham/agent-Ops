-- Close three wide-open read rules. Each table is only ever read by staff
-- screens or by server-side functions using the service role.

DROP POLICY IF EXISTS "cc_cycle_populations_read_authenticated" ON public.cc_cycle_populations;
CREATE POLICY "cc_cycle_populations_read_staff" ON public.cc_cycle_populations
FOR SELECT TO authenticated
USING (
  public.is_welile_staff(auth.uid())
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);

DROP POLICY IF EXISTS "Signed-in users can view redirect monitor alerts" ON public.redirect_monitor_alerts;
CREATE POLICY "Staff can view redirect monitor alerts" ON public.redirect_monitor_alerts
FOR SELECT TO authenticated
USING (
  public.is_welile_staff(auth.uid())
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);

-- Share codes are resolved server-side with the service role, which bypasses RLS.
DROP POLICY IF EXISTS "share codes readable" ON public.merchandise_share_codes;
CREATE POLICY "merchandise_share_codes_staff_read" ON public.merchandise_share_codes
FOR SELECT TO authenticated
USING (
  public.is_welile_staff(auth.uid())
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);
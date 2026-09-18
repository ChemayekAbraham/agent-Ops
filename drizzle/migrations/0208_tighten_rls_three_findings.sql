-- 1. hr_perf_authorities: config table, no longer world-readable to signed-in users
DROP POLICY IF EXISTS hr_perf_auth_read ON public.hr_perf_authorities;
CREATE POLICY hr_perf_auth_read ON public.hr_perf_authorities
FOR SELECT TO authenticated
USING (
  public.hr_perf_has_authority('govern') OR public.hr_pay_is_rule_admin()
  OR public.has_role(auth.uid(), 'hr'::app_role)
  OR public.has_role(auth.uid(), 'ceo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);

-- 2. float_promise_alerts: writes must satisfy the same role predicate as the read
DROP POLICY IF EXISTS "Finance roles acknowledge float promise alerts" ON public.float_promise_alerts;
CREATE POLICY "Finance roles acknowledge float promise alerts" ON public.float_promise_alerts
FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role) OR public.has_role(auth.uid(), 'operations'::app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::app_role)
)
WITH CHECK (
  public.has_role(auth.uid(), 'cfo'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role) OR public.has_role(auth.uid(), 'operations'::app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::app_role)
);

-- 3. business_advance_share_events: share logging stays open, but a row may not
--    be attributed to someone else's account
DROP POLICY IF EXISTS "anyone can log share events" ON public.business_advance_share_events;
CREATE POLICY "anyone can log share events" ON public.business_advance_share_events
FOR INSERT TO anon, authenticated
WITH CHECK (user_id IS NULL OR user_id = auth.uid());

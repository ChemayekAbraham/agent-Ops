-- Internal operating targets and HR performance rules are staff-only.
DROP POLICY IF EXISTS pot_select ON public.partner_ops_targets;
CREATE POLICY pot_select ON public.partner_ops_targets
FOR SELECT TO authenticated
USING (public.is_welile_staff(auth.uid()) OR public.has_role(auth.uid(), 'super_admin'::public.app_role));

DROP POLICY IF EXISTS hr_perf_constants_read ON public.hr_perf_constants;
CREATE POLICY hr_perf_constants_read ON public.hr_perf_constants
FOR SELECT TO authenticated
USING (public.is_welile_staff(auth.uid()) OR public.has_role(auth.uid(), 'super_admin'::public.app_role));

DROP POLICY IF EXISTS hr_metricdef_read ON public.hr_metric_definitions;
CREATE POLICY hr_metricdef_read ON public.hr_metric_definitions
FOR SELECT TO authenticated
USING (public.is_welile_staff(auth.uid()) OR public.has_role(auth.uid(), 'super_admin'::public.app_role));
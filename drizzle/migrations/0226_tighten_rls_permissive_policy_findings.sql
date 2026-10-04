DROP POLICY IF EXISTS system_events_insert_authenticated ON public.system_events;
CREATE POLICY system_events_insert_authenticated
ON public.system_events
FOR INSERT
TO authenticated
WITH CHECK (
  (user_id IS NULL OR user_id = auth.uid())
  AND (actor_id IS NULL OR actor_id = auth.uid())
  AND (triggered_by IS NULL OR triggered_by = auth.uid())
);

DROP POLICY IF EXISTS hr_perf_quality_read ON public.hr_perf_quality;
CREATE POLICY hr_perf_quality_read
ON public.hr_perf_quality
FOR SELECT
TO authenticated
USING (public.hr_perf_has_authority('govern'::text) OR public.hr_pay_is_rule_admin());

DROP POLICY IF EXISTS hr_perf_bands_read ON public.hr_perf_bands;
CREATE POLICY hr_perf_bands_read
ON public.hr_perf_bands
FOR SELECT
TO authenticated
USING (public.hr_perf_has_authority('govern'::text) OR public.hr_pay_is_rule_admin());
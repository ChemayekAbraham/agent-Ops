-- hr_perf_participants: replace USING (true) read with staff/authority scope + own row
DROP POLICY IF EXISTS hr_perf_part_read ON public.hr_perf_participants;
CREATE POLICY hr_perf_part_read ON public.hr_perf_participants
  FOR SELECT TO authenticated
  USING (
    public.hr_perf_has_authority('govern')
    OR public.hr_pay_is_rule_admin()
    OR public.is_welile_staff(auth.uid())
    OR public.has_role(auth.uid(), 'super_admin')
    OR EXISTS (
      SELECT 1 FROM public.hr_staff s
      WHERE s.id = hr_perf_participants.staff_id
        AND s.user_id = auth.uid()
    )
  );

-- proxy_agreement_versions: live versions readable by signers, retired versions staff-only
DROP POLICY IF EXISTS pav_select ON public.proxy_agreement_versions;
CREATE POLICY pav_select ON public.proxy_agreement_versions
  FOR SELECT TO authenticated
  USING (
    retired_at IS NULL
    OR public.is_welile_staff(auth.uid())
    OR public.has_role(auth.uid(), 'super_admin')
  );

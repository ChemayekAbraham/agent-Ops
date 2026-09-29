-- Security fix: staff_surveys_read was USING (true), letting every signed-in user
-- (tenants, agents, landlords, supporters) read the staff survey questions.
-- Scope it to employees plus HR admins/preparers, mirroring staff_survey_responses_read.
-- No table, column, function, trigger or grant changes.

DROP POLICY IF EXISTS staff_surveys_read ON public.staff_surveys;

CREATE POLICY staff_surveys_read ON public.staff_surveys
  FOR SELECT TO authenticated
  USING (
    public.staff_survey_is_employee()
    OR public.hr_is_admin()
    OR public.hr_pay_is_preparer()
  );
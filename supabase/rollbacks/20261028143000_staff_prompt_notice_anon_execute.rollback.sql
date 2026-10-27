-- Undo 20261028143000_staff_prompt_notice_anon_execute.sql.
-- Restores the previous ACL: authenticated and service_role keep EXECUTE;
-- anon does not. Does not change function bodies.

revoke execute on function public.hr_pay_pending_prompt() from anon;
revoke execute on function public.pso_facilitation_pending_prompt() from anon;
revoke execute on function public.staff_loan_pending_prompt() from anon;
revoke execute on function public.staff_requisition_pending_prompt() from anon;
revoke execute on function public.staff_requisition_my_notices() from anon;
revoke execute on function public.staff_survey_pending() from anon;

-- staff_survey_is_employee() has no EXECUTE grant for authenticated (only postgres/service_role),
-- so the RLS expression that now guards staff_surveys would raise permission denied for real users.
-- The function takes no arguments and reports only whether auth.uid() holds an enabled 'employee'
-- role, so EXECUTE for authenticated reveals nothing beyond the caller's own status.

GRANT EXECUTE ON FUNCTION public.staff_survey_is_employee() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.hr_is_engineering() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_is_engineering() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.hr_can_assign_tasks() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_can_assign_tasks() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.hr_my_department_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_my_department_id() TO authenticated;
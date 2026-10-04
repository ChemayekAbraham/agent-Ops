REVOKE EXECUTE ON FUNCTION public.get_budget_department_notifications() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.mark_budget_department_notification_read(uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.budget_can_access_department(uuid, uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.budget_notify_cycle_open(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.get_budget_department_notifications() TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_budget_department_notification_read(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.budget_can_access_department(uuid, uuid) TO authenticated;
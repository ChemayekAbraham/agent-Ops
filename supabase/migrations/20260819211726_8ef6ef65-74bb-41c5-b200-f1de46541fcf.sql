REVOKE ALL ON FUNCTION public.budget_notify_cycle_open(uuid) FROM anon, authenticated, PUBLIC;
REVOKE ALL ON FUNCTION public.budget_department_access_user_ids(uuid) FROM anon, authenticated, PUBLIC;
REVOKE ALL ON FUNCTION public.budget_notify_cycle_open_trg() FROM anon, authenticated, PUBLIC;
REVOKE ALL ON FUNCTION public.budget_create_cycle(text, text, text, date, date, timestamptz, text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.budget_create_cycle(text, text, text, date, date, timestamptz, text) TO authenticated;
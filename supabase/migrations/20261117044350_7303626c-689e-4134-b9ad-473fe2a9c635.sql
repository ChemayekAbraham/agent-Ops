REVOKE EXECUTE ON FUNCTION public.run_agreement_contradiction_check(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.assistant_staff_run_query(text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ops_cases_sync_sources() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_agreement_contradiction_check(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_run_query(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ops_cases_sync_sources() TO service_role;
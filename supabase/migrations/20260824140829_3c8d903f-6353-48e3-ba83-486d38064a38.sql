REVOKE EXECUTE ON FUNCTION public.resolve_user_by_known_phone(text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.resolve_user_by_known_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_user_by_known_phone(text) TO service_role;
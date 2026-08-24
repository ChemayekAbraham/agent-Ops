REVOKE EXECUTE ON FUNCTION public.get_user_advance_reversal_available(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.get_user_advance_reversal_available(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_user_advance_reversal_available(uuid) TO service_role;
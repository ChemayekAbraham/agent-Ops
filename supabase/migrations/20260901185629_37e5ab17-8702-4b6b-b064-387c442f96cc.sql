REVOKE ALL ON FUNCTION public.funder_float_available(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.funder_float_available(uuid) TO service_role;

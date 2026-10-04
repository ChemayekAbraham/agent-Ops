REVOKE ALL ON FUNCTION public.assert_smartphone_pickup_verified(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_smartphone_pickup_verified(uuid) TO service_role;
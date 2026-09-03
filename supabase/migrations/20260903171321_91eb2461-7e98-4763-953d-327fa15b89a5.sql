REVOKE ALL ON FUNCTION public.house_listing_protected_unchanged(uuid, boolean, boolean, boolean, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rent_request_financials_unchanged(uuid, numeric, numeric, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.house_listing_protected_unchanged(uuid, boolean, boolean, boolean, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rent_request_financials_unchanged(uuid, numeric, numeric, numeric, numeric) TO authenticated, service_role;
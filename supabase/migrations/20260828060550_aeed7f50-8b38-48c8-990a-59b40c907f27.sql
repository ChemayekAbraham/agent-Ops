REVOKE EXECUTE ON FUNCTION public.agent_order_spiro_bike_lease(text, numeric, integer, numeric, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.coo_approve_bike_lease(uuid, numeric, integer, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cfo_disburse_bike_lease(uuid, numeric, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.reject_bike_lease(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.list_bike_lease_orders(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.can_review_bike_leases(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.can_coo_approve_bike_leases(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.can_cfo_disburse_bike_leases(uuid) FROM PUBLIC, anon;
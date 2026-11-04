-- landlord call hub RLS policies call public._landlord_hub_can_read().
-- A recent CREATE OR REPLACE left proacl as {postgres=X/postgres} only,
-- so authenticated SELECTs on landlord_calls / landlord_call_dials /
-- landlord_call_amendments fail with 42501. The function is SECURITY
-- DEFINER and already gates on landlord_ops/operations/hr/coo/ceo/cfo/
-- manager/super_admin via has_role; do NOT grant anon.

GRANT EXECUTE ON FUNCTION public._landlord_hub_can_read() TO authenticated;
GRANT EXECUTE ON FUNCTION public._landlord_hub_can_read() TO service_role;

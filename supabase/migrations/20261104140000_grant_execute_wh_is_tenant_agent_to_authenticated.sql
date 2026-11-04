-- RLS policies on public.wh_tenant_identity and storage.objects call
-- public._wh_is_tenant_agent(). Policies run as the signed-in user, and the
-- function was closed to `authenticated` (default-closed grants), so any
-- storage upload (e.g. payout proof) failed with
-- "permission denied for function _wh_is_tenant_agent".
grant execute on function public._wh_is_tenant_agent(uuid, uuid) to authenticated;

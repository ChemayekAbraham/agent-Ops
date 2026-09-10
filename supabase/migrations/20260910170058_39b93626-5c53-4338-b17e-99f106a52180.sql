-- The trigger helper is not a public RPC; only the trigger should invoke it.
REVOKE EXECUTE ON FUNCTION public.enforce_deposit_requests_agent_immutable_fields() FROM PUBLIC, anon, authenticated;

-- RLS policies on portfolio_return_cycle_claims / overrides / compound_reversal_requests
-- call these SECURITY DEFINER helpers. Evaluating the policy requires EXECUTE for
-- authenticated; without it every SELECT fails with 42501 before the policy can
-- return false. anon stays revoked. Idempotent.
GRANT EXECUTE ON FUNCTION public._ledger_can_post_partner_returns(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public._return_cycle_can_request(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public._ledger_can_post_partner_returns(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public._return_cycle_can_request(uuid) FROM anon;

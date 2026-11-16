-- Same cause as 20261121090000: the 2026-10-17 lockdown revoked EXECUTE on a
-- helper that an RLS policy calls as the signed-in user. The staff_read policy
-- on public.partner_agreement_rate_requests calls
-- _partner_return_policy_caller_ok(text[]), so any SELECT by `authenticated`
-- failed with "permission denied for function".
--
-- The helper is SECURITY DEFINER, returns only a boolean for the caller's own
-- uid (role list + staff MFA check), so granting it leaks nothing. No anon.
GRANT EXECUTE ON FUNCTION public._partner_return_policy_caller_ok(text[]) TO authenticated;

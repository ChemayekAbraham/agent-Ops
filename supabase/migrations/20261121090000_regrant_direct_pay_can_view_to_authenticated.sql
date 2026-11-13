-- Merchant Agents (and anyone else signed in) got "permission denied for
-- function _direct_pay_can_view" when confirming a payout / uploading proof.
--
-- Cause: the storage.objects SELECT policy `direct_pay_staff_read_offplatform_receipt`
-- calls `public._direct_pay_can_view(auth.uid())`. Storage policies are
-- evaluated as the caller (role `authenticated`), but the 2026-10-17
-- "lock down unused owner-rights functions" pass revoked EXECUTE on the
-- function from everyone except owner/service_role, treating it as unused.
-- Any storage read/upload by a non-owner session then errors out while the
-- policy is evaluated.
--
-- Fix: grant EXECUTE back to `authenticated`. The function is a boolean
-- helper that only returns true for landlord_ops / coo / super_admin with MFA
-- satisfied (staff_mfa_ok()) and takes the caller's own uid, so exposing it
-- reveals nothing and the policy remains the real gate. `anon` is not granted.

GRANT EXECUTE ON FUNCTION public._direct_pay_can_view(uuid) TO authenticated;

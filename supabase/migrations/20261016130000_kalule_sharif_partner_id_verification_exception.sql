-- ID-verification exception for KALULE SHARIF (partner account, sharifkc264@gmail.com).
--
-- This is the partner account of agent Sharifu Kalule (main account 98ee118b, kalulesharif618).
-- It has no agent collections, visits or rent requests. On 2026-10-16 07:23 UTC he tried to
-- withdraw to 0757229748, which is already verified on his main account under the same
-- National ID (typed CMO305... here, CM0305... there; the duplicate check normalises O/0).
-- payout_destination_verifications f1068cff was auto-rejected as "National ID already
-- recorded on another account", and issue-wallet-withdrawal-otp refuses a rejected
-- destination unless the user has an id_verification_exceptions row. The submit-side gate
-- (withdrawal_destination_gate) already exempts pure partners; the OTP path does not.
-- Josh approved a per-user exception on 2026-10-16.
--
-- Idempotent: does nothing if the user already has an active (unrevoked) exception.
-- granted_by is NULL (applied through the service); the reason text carries the approver.
-- Revoke by setting revoked_at on the row.

WITH ins AS (
  INSERT INTO public.id_verification_exceptions (user_id, reason)
  SELECT '3f87c1f3-6564-478d-a08d-43da24614c80',
         'KALULE SHARIF partner account (sharifkc264@gmail.com): same person as agent Sharifu Kalule (98ee118b). Withdrawal to 0757229748 auto-rejected as duplicate National ID; OTP path has no pure-partner exemption. Exception granted by Josh Wanda 2026-10-16.'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.id_verification_exceptions
    WHERE user_id = '3f87c1f3-6564-478d-a08d-43da24614c80' AND revoked_at IS NULL
  )
  RETURNING id, user_id
)
INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, reason, new_values)
SELECT ins.user_id, 'data_correction', 'ID_VERIFICATION_EXCEPTION_GRANTED', 'id_verification_exceptions', ins.id,
       'Partner account of an agent was auto-rejected at withdrawal for sharing a National ID with the agent account; exception approved by Josh Wanda 2026-10-16.',
       jsonb_build_object('user_id', ins.user_id, 'phone', '0757229748')
FROM ins;

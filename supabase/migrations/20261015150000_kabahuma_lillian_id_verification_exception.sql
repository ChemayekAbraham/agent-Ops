-- ID-verification exception for KABAHUMA LILLIAN (0706662454).
--
-- Her payout number was auto-verified as "partner with no agent activity"
-- (user_is_pure_partner = true), but payout_withdrawal_block_reasons exempts
-- only is_partner_not_agent, which is false because she also holds the agent
-- role. She has no ID photos, selfie or identity binding, so the withdrawal
-- screen kept demanding them. Josh approved a per-user exception on
-- 2026-10-15; this file records the row that was applied live.
--
-- Idempotent: does nothing if she already has an active (unrevoked) exception.
-- granted_by is NULL (applied through the service, not a signed-in user); the
-- reason text carries the approver.

WITH ins AS (
  INSERT INTO public.id_verification_exceptions (user_id, reason)
  SELECT '5f277e34-a830-4ebb-8680-c0c074b279da',
         '0706662454 Kabahuma Lillian: payout number already verified (auto-verified partner); withdrawal gate used is_partner_not_agent and demanded ID photos again. Exception granted by Josh Wanda 2026-10-15.'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.id_verification_exceptions
    WHERE user_id = '5f277e34-a830-4ebb-8680-c0c074b279da' AND revoked_at IS NULL
  )
  RETURNING id, user_id
)
INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, reason, new_values)
SELECT ins.user_id, 'data_correction', 'ID_VERIFICATION_EXCEPTION_GRANTED', 'id_verification_exceptions', ins.id,
       'Verified partner who also holds the agent role was re-asked for ID photos at withdrawal; exception approved by Josh Wanda 2026-10-15.',
       jsonb_build_object('user_id', ins.user_id, 'phone', '0706662454')
FROM ins;

-- Data remediation for the 2026-09-14 referral-bonus bot-signup ring.
-- Root cause fixed in 20260914140000_restore_referral_bonus_milestone_requirement.sql.
-- This is the one-time cleanup of what the exploit already produced:
--
--   17 referrer accounts drove ~25,732 throwaway signups (10+ signups per
--   referrer per 10-minute window, all unverified email -- the
--   `burst_signup` heuristic in cto_fake_account_base()) and collected
--   UGX 3,282,700 in `referral_bonus` ledger credits, of which
--   UGX 3,172,500 was already withdrawn before this fix. None of the 25,732
--   bot accounts themselves ever held a wallet balance, a ledger entry, or
--   a rent request -- confirmed before touching anything.
--
-- Two actions, both reversible, neither one deletes ledger history:
--   1. The 17 referrer accounts are frozen via the existing
--      `fraud_block_user_identifiers()` (blocks every identifier they've
--      ever used for payouts too) -- this is what actually stops the
--      remaining ~UGX 240,800 sitting in their wallets from being
--      withdrawn (enforced by the `enforce_no_fraud_withdrawal_request`
--      trigger, which was already live and checks `profiles.is_frozen`).
--   2. The 25,732 bot accounts are soft-deleted using the same pattern as
--      `admin_soft_delete_account()` (register in `deleted_accounts`,
--      redact PII, freeze, drop their `user_roles`/`push_subscriptions`).
--      Done as raw SQL rather than via the RPC because the RPC requires an
--      authenticated staff `auth.uid()` session, which a migration does
--      not have; `deleted_by`/`blocked_by` are set to Josh Wanda's real
--      user_id for audit attribution. Fully reversible via
--      `admin_restore_soft_deleted_account()`.
--
-- See docs/HANDOVER/21-referral-bonus-bot-signup-fraud-ring.md.

DO $$
DECLARE
  v_actor uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6'; -- Josh Wanda (cto/manager/ceo)
  v_reason text := 'Referral-bonus bot-signup ring: drove 10+ throwaway signups per 10-min window (25,732 total referred accounts, all unverified email) to farm UGX-100 referral bonuses. UGX 3,282,700 credited, UGX 3,172,500 already withdrawn. Confirmed 2026-09-14.';
  v_referrer_ids uuid[] := ARRAY[
    'c1ebb2b0-6d8e-4aff-9d0c-17adb1a6ff6e','fc7837ea-526a-4511-bd3a-8c37ed60ebf9',
    '52d458f7-a3dd-4d4e-8d0e-6b4714a6879e','ee02ff74-3ec8-4472-89b2-ff2f1b9254d9',
    '819f717f-6c66-47a8-8da8-606beedaf192','2ae6c920-f77a-4eec-a84d-5dd8f651fcde',
    '4d21fe5b-38c9-4b5e-8c93-6b9cca9aae7b','dd6bdec3-3317-4543-9269-759d0086a117',
    '40341d55-5af5-4dfc-a6bc-3d34e60413b1','a5ee56eb-473f-404e-82ba-ac7d71afa359',
    'd981be9a-8c4d-435e-bc2b-1ecf7a1578d9','fa5835e4-32f2-42cd-97f4-caa4717a9a78',
    '1e3babbf-fccb-44c8-9e92-d58711020b06','bbef3c10-5ac7-4091-98b7-291e0a3d3f07',
    '39d7f264-d111-478a-9905-4a76ea8801d1','f5994e00-af24-4a25-a1de-fc22a214381f',
    'fb7762d5-85eb-4411-876e-a0c4bc6ad4e2'
  ];
  v_id uuid;
BEGIN
  -- 1) Freeze the 17 referrer accounts that collected/withdrew the bonus.
  FOREACH v_id IN ARRAY v_referrer_ids LOOP
    PERFORM public.fraud_block_user_identifiers(v_id, v_reason, v_actor);
  END LOOP;
END $$;

-- 2) Soft-delete every confirmed bot account (burst_signup pattern),
--    replicating admin_soft_delete_account()'s effect at scale.
CREATE TEMP TABLE tmp_bot_ids AS
SELECT user_id FROM public.cto_fake_account_base() WHERE burst_signup;

CREATE TEMP TABLE tmp_bot_snapshot AS
SELECT p.id AS user_id, p.full_name, p.email, p.phone, p.national_id
FROM public.profiles p
JOIN tmp_bot_ids t ON t.user_id = p.id
WHERE p.deleted_at IS NULL;

CREATE TEMP TABLE tmp_bot_roles AS
SELECT ur.user_id, jsonb_agg(jsonb_build_object('role', ur.role, 'enabled', true)) AS roles
FROM public.user_roles ur
JOIN tmp_bot_ids t ON t.user_id = ur.user_id
GROUP BY ur.user_id;

INSERT INTO public.deleted_accounts (user_id, full_name, email, phone, national_id, roles, status, reason, deleted_by)
SELECT s.user_id, s.full_name, s.email, s.phone, s.national_id,
       COALESCE(r.roles, '[]'::jsonb), 'soft_deleted',
       'Confirmed bot signup: referral-bonus fraud ring (burst-signup pattern, unverified email). Remediated 2026-09-14; see docs/HANDOVER/21-referral-bonus-bot-signup-fraud-ring.md.',
       'cb798acb-68bc-4b4e-a414-a3d374e030b6'
FROM tmp_bot_snapshot s
LEFT JOIN tmp_bot_roles r ON r.user_id = s.user_id;

DELETE FROM public.user_roles WHERE user_id IN (SELECT user_id FROM tmp_bot_ids);
DELETE FROM public.push_subscriptions WHERE user_id IN (SELECT user_id FROM tmp_bot_ids);

UPDATE public.profiles p SET
  full_name = CASE WHEN p.full_name LIKE '[DELETED]%' THEN p.full_name ELSE '[DELETED] ' || COALESCE(p.full_name,'Account') END,
  previous_full_name = COALESCE(p.previous_full_name, p.full_name),
  email = 'deleted+' || p.id::text || '@deleted.invalid',
  phone = NULL,
  national_id = NULL,
  mobile_money_number = NULL,
  is_frozen = true,
  frozen_at = COALESCE(p.frozen_at, now()),
  frozen_reason = 'Account deleted: confirmed bot signup (referral-bonus fraud ring), 2026-09-14 remediation',
  deleted_at = now(),
  deleted_by = 'cb798acb-68bc-4b4e-a414-a3d374e030b6',
  deletion_reason = 'Confirmed bot signup: referral-bonus fraud ring (burst-signup pattern, unverified email). Remediated 2026-09-14.'
FROM tmp_bot_snapshot s
WHERE p.id = s.user_id;

INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
SELECT 'cb798acb-68bc-4b4e-a414-a3d374e030b6', 'soft_delete_account', 'soft_delete_account', 'profiles', user_id::text,
  jsonb_build_object(
    'reason','Confirmed bot signup: referral-bonus fraud ring, 2026-09-14 bulk remediation',
    'performed_by','cb798acb-68bc-4b4e-a414-a3d374e030b6',
    'bulk_remediation', true
  )
FROM tmp_bot_snapshot;

DROP TABLE tmp_bot_ids;
DROP TABLE tmp_bot_snapshot;
DROP TABLE tmp_bot_roles;

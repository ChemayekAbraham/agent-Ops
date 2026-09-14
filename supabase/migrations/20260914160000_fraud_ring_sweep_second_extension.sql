-- Second extension of the referral-bonus bot-signup fraud ring fix
-- (20260914140000 / 141000 / 150000).
--
-- Re-measured the broader ~8,798-account "all four roles at the same
-- instant" population flagged earlier as a weaker, unverified signal. That
-- measure turned out to be wrong in both directions: it missed real fraud
-- (some bot rings set the role field correctly and never tripped it) and
-- it would have wrongly implicated real agent-driven growth (one referrer
-- in that pool, 864b1df4..., turned out to be a genuine agent with 1,456
-- real sub-agent/customer signups via the normal @welile.agent synthetic
-- email pattern -- left untouched).
--
-- Re-measuring on total-referred-count + time concentration + name/email
-- diversity (a bot cohort reuses one or two fake names across hundreds of
-- rows; a real agent's cohort has mostly distinct names) isolated 5 more
-- confirmed referrers running the identical pattern to the original 19:
-- incrementing-digit near-duplicate emails (bablon132@gmail.com,
-- bablon133@gmail.com, ...), sequential phone numbers, one/few fake names
-- reused across dozens-to-hundreds of accounts.
--
--   Asiime Meresi   (asiimemeresi@gmail.com)  - 383 bots, UGX 38,300 bonus
--   Lubega Twaha    (lubegatwaha62@gmail.com) - 199 bots, UGX 18,800 bonus
--   Aniwar Ssempijja                          -  63 bots, UGX  6,300 bonus
--   Isa Kato        (same email as Lubega Twaha) - 54 bots, UGX 5,400 bonus
--   Seez Records                              -  21 bots, UGX  2,100 bonus
--
-- All 5 frozen (fraud_block_user_identifiers). 720 referred bot accounts
-- soft-deleted (708 gmail-pattern + 12 synthetic-@welile.agent stragglers
-- with gibberish names under the same referrers).
--
-- A much larger pool (256 referrers / ~54,000 accounts / UGX 17.4M bonus /
-- UGX 157M withdrawn) was measured but deliberately NOT touched -- per the
-- 864b1df4 false-positive check, that pool is dominated by real agent
-- activity. Each one needs the same individual verification before any
-- action.
--
-- See docs/HANDOVER/21-referral-bonus-bot-signup-fraud-ring.md.

DO $$
DECLARE
  v_actor uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6';
  v_reason text := 'Referral-bonus bot-signup fraud ring (same pattern as the original 19): near-duplicate incrementing-digit emails, sequential phone numbers, one/few fake names reused across dozens of accounts. Confirmed 2026-09-14.';
BEGIN
  PERFORM public.fraud_block_user_identifiers('959d2cfb-1d02-4e20-b399-e78d00f7619a', v_reason, v_actor);
  PERFORM public.fraud_block_user_identifiers('8fff2a0e-928c-4503-a08b-0dda81099976', v_reason, v_actor);
  PERFORM public.fraud_block_user_identifiers('4dbeec44-3993-44ee-a6e7-01861c081b2f', v_reason, v_actor);
  PERFORM public.fraud_block_user_identifiers('d7f11416-ce84-47a1-ae57-2727fb1c5e2b', v_reason, v_actor);
  PERFORM public.fraud_block_user_identifiers('9201e6bc-a069-4823-839a-5870ee6a31fd', v_reason, v_actor);
END $$;

CREATE TEMP TABLE tmp_bot_ids AS
SELECT p.id AS user_id
FROM public.profiles p
WHERE p.deleted_at IS NULL
  AND p.referrer_id IN (
    '959d2cfb-1d02-4e20-b399-e78d00f7619a','8fff2a0e-928c-4503-a08b-0dda81099976',
    '4dbeec44-3993-44ee-a6e7-01861c081b2f','d7f11416-ce84-47a1-ae57-2727fb1c5e2b',
    '9201e6bc-a069-4823-839a-5870ee6a31fd'
  );

CREATE TEMP TABLE tmp_bot_snapshot AS
SELECT p.id AS user_id, p.full_name, p.email, p.phone, p.national_id
FROM public.profiles p
JOIN tmp_bot_ids t ON t.user_id = p.id;

CREATE TEMP TABLE tmp_bot_roles AS
SELECT ur.user_id, jsonb_agg(jsonb_build_object('role', ur.role, 'enabled', true)) AS roles
FROM public.user_roles ur
JOIN tmp_bot_ids t ON t.user_id = ur.user_id
GROUP BY ur.user_id;

INSERT INTO public.deleted_accounts (user_id, full_name, email, phone, national_id, roles, status, reason, deleted_by)
SELECT s.user_id, s.full_name, s.email, s.phone, s.national_id,
       COALESCE(r.roles, '[]'::jsonb), 'soft_deleted',
       'Confirmed bot signup: referred by a known referral-bonus fraud ring account (incrementing-digit near-duplicate emails). Remediated 2026-09-14 (second extension); see docs/HANDOVER/21-referral-bonus-bot-signup-fraud-ring.md.',
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
  frozen_reason = 'Account deleted: confirmed bot signup referred by known fraud ring account, 2026-09-14 remediation (second extension)',
  deleted_at = now(),
  deleted_by = 'cb798acb-68bc-4b4e-a414-a3d374e030b6',
  deletion_reason = 'Confirmed bot signup: referred by a known referral-bonus fraud ring account (incrementing-digit emails). Remediated 2026-09-14 (second extension).'
FROM tmp_bot_snapshot s
WHERE p.id = s.user_id;

INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
SELECT 'cb798acb-68bc-4b4e-a414-a3d374e030b6', 'soft_delete_account', 'soft_delete_account', 'profiles', user_id::text,
  jsonb_build_object(
    'reason','Confirmed bot signup, referred by known fraud ring account, 2026-09-14 remediation (second extension)',
    'performed_by','cb798acb-68bc-4b4e-a414-a3d374e030b6',
    'bulk_remediation', true
  )
FROM tmp_bot_snapshot;

DROP TABLE tmp_bot_ids;
DROP TABLE tmp_bot_snapshot;
DROP TABLE tmp_bot_roles;

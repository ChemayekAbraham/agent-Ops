-- Critical fix: the 2026-09-15 identity-binding backfill
-- (drizzle/migrations/0118_identity_binding_locked_withdrawal_number.sql)
-- picked one payout_destination_verifications row per user via
--   ORDER BY (status='verified') DESC, (ownership_code_confirmed_at IS NOT NULL) DESC, created_at ASC
-- When a user has multiple destination rows sharing an identical
-- created_at timestamp (many do, from an earlier bulk operation), that
-- final tiebreak is arbitrary — Postgres does not guarantee a stable order
-- without a unique key in ORDER BY. Confirmed live 2026-09-15: 10 of the
-- 31 backfilled user_identity_bindings rows got locked to a completely
-- unrelated person's mobile money account (payout_name_match_report score
-- 0.00 against the account holder's own legal name) — e.g. agent Nattu
-- Sharifah's withdrawal identity was locked to landlord "Luvumba sowedi"'s
-- number, reported directly by the agent ("I'm seeing landlord's name and
-- number which don't belong to me").
--
-- This is an active risk, not a cosmetic one: submit_withdrawal_request()
-- forces every self-withdrawal to resolve_withdrawal_destination()'s
-- locked number regardless of what the withdrawer enters. Checked all 10
-- accounts for withdrawals since the bad backfill ran (2026-09-15
-- 17:10:28 UTC) — none has yet submitted a genuine self-withdrawal under
-- the wrong lock, so no money has actually been misdirected. But the risk
-- is live for all 10 until this is reverted.
--
-- Fix: revoke and null out only the 10 confirmed-mismatched bindings
-- (score 0.00 — no ambiguity, not a borderline call). locked_payout_number
-- is immutable-by-trigger once set, and the trigger only permits changes
-- when OLD.status is already 'revoked' — hence two separate statements.
-- After this, resolve_withdrawal_destination() falls back to the
-- profile's own mobile_money_number (or blocks the withdrawal outright if
-- that's also unset) instead of paying a stranger. Each affected user can
-- redo identity capture (complete_identity_binding) normally afterward,
-- which will then correctly pick their own verified destination.
--
-- Deliberately scoped to score = 0.00 (total mismatch) only — never
-- touches a binding with any real match, so this can't misfire on a
-- borderline/legitimate case.

WITH bad_bindings AS (
  SELECT b.id
  FROM public.user_identity_bindings b
  WHERE b.capture_source = 'backfill_2026_09_15'
    AND b.status <> 'revoked'
    AND (public.payout_name_match_report(b.full_legal_name, b.locked_payout_name)->>'score')::numeric = 0
)
UPDATE public.user_identity_bindings
SET status = 'revoked'
WHERE id IN (SELECT id FROM bad_bindings);

WITH bad_bindings AS (
  SELECT b.id
  FROM public.user_identity_bindings b
  WHERE b.capture_source = 'backfill_2026_09_15'
    AND b.status = 'revoked'
    AND b.locked_payout_number IS NOT NULL
    AND (public.payout_name_match_report(b.full_legal_name, b.locked_payout_name)->>'score')::numeric = 0
)
UPDATE public.user_identity_bindings
SET locked_payout_number = NULL, locked_payout_name = NULL, locked_payout_provider = NULL
WHERE id IN (SELECT id FROM bad_bindings);

INSERT INTO public.audit_logs (user_id, action_type, table_name, reason, metadata)
SELECT
  NULL, 'identity_binding_misattribution_revoked', 'user_identity_bindings',
  format('Backfill locked this account''s withdrawal identity to an unrelated person''s mobile money account (name match score 0.00: "%s" vs holder "%s"). Revoked to stop the active payout-misdirection risk; the holder must redo identity capture.', b.locked_payout_name, b.full_legal_name),
  jsonb_build_object('binding_id', b.id, 'user_id', b.user_id, 'wrong_locked_name', b.locked_payout_name)
FROM public.user_identity_bindings b
WHERE b.capture_source = 'backfill_2026_09_15' AND b.status = 'revoked' AND b.locked_payout_number IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.audit_logs a
    WHERE a.action_type = 'identity_binding_misattribution_revoked' AND (a.metadata->>'binding_id')::uuid = b.id
  );

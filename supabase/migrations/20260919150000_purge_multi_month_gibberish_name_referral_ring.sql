-- Root-cause trace: docs/HANDOVER/85-gibberish-name-referral-ring-root-cause-and-purge.md
--
-- 53 referrer identities, 2026-02-11 -> 2026-09-14, fed 4,499 confirmed-garbage-name
-- accounts (empty/too-short/repeated-char/vowel-less gibberish full_name) through the
-- general public phone-OTP signup path with a referrer_id attached, exploiting the
-- since-fixed get_referral_progress() "bare signup qualifies" bug (doc 21). Every one
-- of these accounts has zero wallet balance, zero house_listings, zero
-- agent_collections, zero withdrawal_requests, and zero FUNDED rent_requests (193
-- rent_requests rows exist among them, all stuck at service_center_review/
-- cancelled/rejected -- never funded, never disbursed). The only general_ledger rows
-- touching any of them are a single net-zero admin correction on one already-known
-- garbage account ("gh"). Nothing here is reachable from general_ledger, and this
-- migration never writes to it.
--
-- This is a historical backlog, not a live incident: the two structural entry points
-- are already closed -- 20260914170000_harden_signup_velocity_guard.sql caps new
-- signups to 5/hour or 10/day per referrer (verified zero new accounts under any of
-- these 53 referrers since 2026-09-14 17:00 UTC), and get_referral_progress() no
-- longer has the bare-signup bug live. The standing hunter
-- (scan_and_quarantine_bot_referral_rings, docs/HANDOVER/23) never caught this ring
-- because it only scans the last 48 hours, because this ring's bot names are
-- randomized/unique per account (97%+ distinct) rather than 1-2 reused names (its
-- <0.4 distinct-name-ratio signal reads high diversity as "real users"), and because
-- its purge step only targets accounts with a NULL email_confirmed_at -- every one of
-- these 4,499 phone-OTP accounts has its synthetic placeholder email auto-confirmed
-- at creation, so it would never match that filter regardless of the other two
-- signals. See the handover doc for the recommended fix to those gaps (not applied
-- here -- that's a change to a standing automated function, a separate decision).
--
-- Referral-bonus money is NOT addressed by this migration. The 53 referrers show
-- 33,318 general_ledger rows tagged 'referral' totalling UGX 10,931,000 -- but that
-- figure mixes legitimate earnings from these same accounts' real (non-bot) referred
-- users, since total referred volume per referrer is often much larger than the
-- garbage-name count. Separating fraud proceeds from real earnings needs a row-level
-- trace against the `referrals` table, which is a human FinOps call (same precedent
-- as the OKIROR ANDREW ring, doc 39) -- not attempted here.
--
-- Same mechanism as docs/HANDOVER/39's purge and the standing hunter: reversible
-- soft-delete (deleted_accounts insert, PII scrub, is_frozen, audit_logs row), never
-- a hard DELETE, never touches general_ledger. Asserts the exact expected counts
-- before doing anything and aborts otherwise, so this can't silently act on a
-- different-shaped result if the underlying data changed between investigation and
-- apply.

DO $$
DECLARE
  v_actor uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6'; -- Josh Wanda, same standing authorization as doc 23/39
  v_reason text := 'Manual review 2026-09-19: multi-month gibberish-name referral ring, root cause traced to docs/HANDOVER/85. Verified zero wallet balance, zero listings, zero collections, zero withdrawals, zero funded rent_requests.';
  v_referrer_count int;
  v_bot_count int;
  v_bot_ids uuid[];
  v_referrer_ids uuid[];
  v_need_freeze int;
BEGIN
  -- Reproduce the exact selection verified during investigation.
  CREATE TEMP TABLE tmp_ring_bots ON COMMIT DROP AS
  WITH base AS (
    SELECT id, full_name, referrer_id, created_at
    FROM public.profiles
    WHERE full_name IS NOT NULL AND deleted_at IS NULL
  ), flagged AS (
    SELECT *, trim(full_name) AS name_trim, lower(trim(full_name)) AS name_lc
    FROM base
  ), tagged AS (
    SELECT *,
      CASE
        WHEN length(name_trim) <= 2 THEN 'too short'
        WHEN name_lc ~ '^(.)\1+$' THEN 'repeated char'
        WHEN name_lc ~ '^[^aeiou\s]+$' AND length(name_trim) > 3 AND name_trim !~ '^[0-9 ]+$' THEN 'no vowels'
        ELSE NULL
      END AS flag_reason
    FROM flagged
  ), fl AS (
    SELECT * FROM tagged WHERE flag_reason IS NOT NULL
  ), top_referrers AS (
    SELECT referrer_id FROM fl GROUP BY referrer_id HAVING count(*) >= 15
  )
  SELECT fl.id, fl.referrer_id
  FROM fl
  WHERE fl.referrer_id IN (SELECT referrer_id FROM top_referrers);

  SELECT count(DISTINCT referrer_id), count(*) INTO v_referrer_count, v_bot_count FROM tmp_ring_bots;

  IF v_referrer_count <> 53 OR v_bot_count <> 4499 THEN
    RAISE EXCEPTION 'Expected 53 referrers / 4499 bot accounts, found % referrers / % bots. Aborting -- underlying data has changed since investigation, re-verify before purging.',
      v_referrer_count, v_bot_count;
  END IF;

  -- Re-verify the zero-real-activity guarantee inside the same transaction as the purge.
  IF EXISTS (
    SELECT 1 FROM public.wallets w WHERE w.user_id IN (SELECT id FROM tmp_ring_bots) AND w.balance <> 0
  ) OR EXISTS (
    SELECT 1 FROM public.withdrawal_requests wr WHERE wr.user_id IN (SELECT id FROM tmp_ring_bots)
  ) OR EXISTS (
    SELECT 1 FROM public.rent_requests rr
    WHERE (rr.tenant_id IN (SELECT id FROM tmp_ring_bots)
        OR rr.agent_id IN (SELECT id FROM tmp_ring_bots)
        OR rr.landlord_id IN (SELECT id FROM tmp_ring_bots))
      AND rr.status NOT IN ('service_center_review','cancelled','rejected')
  ) THEN
    RAISE EXCEPTION 'Re-verification failed: a target account has non-zero wallet balance, a withdrawal request, or a funded rent_request. Aborting -- do not purge, investigate the mismatch first.';
  END IF;

  SELECT array_agg(id) INTO v_bot_ids FROM tmp_ring_bots;
  SELECT array_agg(DISTINCT referrer_id) INTO v_referrer_ids FROM tmp_ring_bots;

  SELECT count(*) INTO v_need_freeze
  FROM unnest(v_referrer_ids) rid JOIN public.profiles p ON p.id = rid WHERE NOT p.is_frozen;

  -- 1. Freeze the referrers (skips any already frozen; fraud_block_user_identifiers
  --    is idempotent and blocks every identifier they've used, same as the hunter).
  PERFORM public.fraud_block_user_identifiers(rid, v_reason, v_actor)
  FROM unnest(v_referrer_ids) AS rid
  JOIN public.profiles p ON p.id = rid
  WHERE NOT p.is_frozen;

  -- 2. Soft-delete the bot cohort -- identical shape to
  --    scan_and_quarantine_bot_referral_rings()'s purge step and doc 39's manual purge.
  INSERT INTO public.deleted_accounts (user_id, full_name, email, phone, national_id, roles, status, reason, deleted_by)
  SELECT p.id, p.full_name, p.email, p.phone, p.national_id,
         COALESCE(
           (SELECT jsonb_agg(jsonb_build_object('role', ur.role, 'enabled', true))
            FROM public.user_roles ur WHERE ur.user_id = p.id),
           '[]'::jsonb
         ),
         'soft_deleted',
         v_reason,
         v_actor
  FROM public.profiles p
  WHERE p.id = ANY(v_bot_ids);

  DELETE FROM public.user_roles WHERE user_id = ANY(v_bot_ids);
  DELETE FROM public.push_subscriptions WHERE user_id = ANY(v_bot_ids);

  UPDATE public.profiles p SET
    full_name = CASE WHEN p.full_name LIKE '[DELETED]%' THEN p.full_name ELSE '[DELETED] ' || COALESCE(p.full_name,'Account') END,
    previous_full_name = COALESCE(p.previous_full_name, p.full_name),
    email = 'deleted+' || p.id::text || '@deleted.invalid',
    phone = NULL, national_id = NULL, mobile_money_number = NULL,
    is_frozen = true, frozen_at = COALESCE(p.frozen_at, now()),
    frozen_reason = 'Account deleted: multi-month gibberish-name referral ring purge, ' || now()::text,
    deleted_at = now(), deleted_by = v_actor,
    deletion_reason = v_reason
  WHERE p.id = ANY(v_bot_ids);

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  SELECT v_actor, 'soft_delete_account', 'soft_delete_account', 'profiles', bot_id::text,
    jsonb_build_object('reason', v_reason, 'performed_by', v_actor, 'automated', false, 'session', 'manual-review-2026-09-19')
  FROM unnest(v_bot_ids) AS bot_id;

  -- 3. Log to the same detections table the standing hunter uses, so this shows up
  --    in the one place ops already knows to check.
  INSERT INTO public.bot_referral_ring_detections (
    referrer_id, referred_count, distinct_names, synthetic_email_count, span_hours, action_taken, bots_soft_deleted, notes
  )
  SELECT t.referrer_id, count(*), count(DISTINCT b.full_name), count(*), NULL,
    'frozen_and_purged_manual_backfill', count(*),
    'Manual 2026-09-19 backfill purge, older than the 48h automated hunter window. See docs/HANDOVER/85.'
  FROM tmp_ring_bots t
  JOIN public.profiles b ON b.id = t.id
  GROUP BY t.referrer_id;

  RAISE NOTICE 'Purged % bot accounts under % referrers (% newly frozen).', v_bot_count, v_referrer_count, v_need_freeze;
END $$;

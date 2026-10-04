-- Bot-referral-ring hunter v2 — rebuilt after docs/HANDOVER/85 found a 7-month, 4,499-account
-- ring (docs/HANDOVER/85-gibberish-name-referral-ring-root-cause-and-purge.md) that the v1
-- hunter (20260914180000, docs/HANDOVER/23) never once caught, despite running every 30 minutes
-- the entire time. Read this header before touching detection thresholds again — every constant
-- below exists because a REAL ring was measured against it, in one direction or the other.
--
-- =============================================================================================
-- WHY V1 FAILED — three independent blind spots, so future readers don't re-introduce any of them
-- =============================================================================================
--
-- 1. IT ONLY EVER LOOKED AT THE LAST 48 HOURS.
--    v1's cohort query was `WHERE p.created_at > now() - interval '48 hours'`. A ring that ran
--    for 7 months (this one) or that a human found 40+ hours after the fact (docs/HANDOVER/39's
--    2026-08-18 burst) was permanently invisible to it, forever, even though it scanned every 30
--    minutes without fail. Two real incidents, same root cause: THE FIX MUST NOT BE TIME-BOXED.
--    v2 has no time window on the referred cohort at all — it looks at a referrer's ENTIRE live
--    (non-deleted) history every scan.
--
--    This does mean v2 re-aggregates a wider set on every run than v1 did — deliberately not
--    solved by skipping already-frozen referrers (a draft of this migration tried exactly that
--    and was caught, live, within the same session it was deployed: two referrers frozen by
--    earlier *unrelated* manual cleanups — `kagwa hassan`, `MUHANGUZI MICHEAL` — had never
--    actually had their bot cohorts purged, because v1's purge step used the broken
--    `email_confirmed_at` filter below. Gating the scan itself on `is_frozen` would have made
--    that failure permanent for any referrer frozen by a process other than this function. v2
--    instead self-limits the honest way: once a referrer's entire LIVE bot cohort is purged,
--    their live `referred_count` drops below the detection threshold on its own and they stop
--    being returned by the query — no explicit `is_frozen` filter needed, and no risk of ever
--    permanently excluding a referrer just because *something else* froze them first.
--
--    >>> NOTE, not a numbered blind spot, kept so the mistake isn't repeated: an intermediate
--    >>> version of this migration filtered the scan to `WHERE NOT rp.is_frozen`, reasoning that
--    >>> a frozen referrer must already be "handled". That is the exact same shape of assumption
--    >>> that caused blind spot #1 -- it was caught live, in production, within the same session
--    >>> this migration was first deployed. If you are tempted to add a similar "already handled,
--    >>> skip it" shortcut anywhere in this function, re-read this paragraph first.
--
-- 2. THE NAME-DIVERSITY SIGNAL ASSUMED A BOT REUSES 1-2 FIXED NAMES.
--    v1's only content signal was `distinct_names / referred_count < 0.4` — correct for OKIROR
--    ANDREW's ring (docs/HANDOVER/39 finding 2: "morning" x166, "morning too" x61, ~6 names
--    across 709 accounts) but exactly backwards for docs/HANDOVER/85's ring, which generates a
--    UNIQUE random keyboard-mash per account (97%+ distinct names across 4,499 accounts). High
--    name diversity is not evidence of anything on its own — it is only evidence of *how* the bot
--    generator was written. v2 adds a second, independent signal that doesn't care about reuse at
--    all: what fraction of names are individually low-quality (empty, ≤2 chars, a repeated
--    character, digits-only, a known placeholder word, or vowel-less gibberish — the exact
--    per-account test used to find the ring in the first place). A referrer trips v2 if EITHER
--    signal fires. A real referrer's cohort (real human names) fails both independently — see
--    "Validation" below, this is not a new unverified guess.
--
-- 3. THE "MOSTLY NON-SYNTHETIC-EMAIL" REQUIREMENT EXCLUDED THE EXACT RINGS THAT MATTER MOST.
--    v1 required `synthetic_email_count / referred_count < 0.5` to fire — i.e. it only ever
--    flagged rings where MOST accounts had a normal-looking email, on the theory that a mostly-
--    synthetic-email cohort is "just legitimate agent-assisted phone recruitment." Both real
--    rings found this session are ~100% synthetic email (`@noapp.welile.user` for phone-OTP
--    tenants, `@welile.agent` for OKIROR ANDREW's cohort) — this condition excluded BOTH of them
--    by construction, not by accident. Email pattern was never a reliable fraud/not-fraud signal;
--    name quality and referral volume are. v2 still records the synthetic-email ratio on every
--    detection (useful context for a human reviewing the log) but no longer gates on it.
--
-- =============================================================================================
-- VALIDATION — what v2's two content signals were checked against before shipping
-- =============================================================================================
--
--  Case                              | distinct/referred | low_quality/referred | v1 result | v2 result
--  ---------------------------------|--------------------|-----------------------|-----------|----------
--  OKIROR ANDREW ring (doc 39 #2)    | ~1%  (6/709)       | high (chat-text names)| caught*   | caught (signal A)
--  docs/HANDOVER/85 ring             | ~97% (unique junk) | high (gibberish)      | MISSED    | caught (signal B)
--  Real control, 864b1df4 (doc 23)   | 89% distinct       | ~0% (real names)      | cleared   | cleared (both signals fail)
--
--  * OKIROR ANDREW's ring passed v1's diversity signal but was excluded anyway by the
--    synthetic-email gate (100% synthetic) — v1 never actually caught it either. Both real rings
--    found this session slipped past v1 for different reasons; v2's redesign closes both.
--
-- =============================================================================================
-- WHAT CHANGED IN THE PURGE STEP — this is the part that "preserves financial history"
-- =============================================================================================
--
-- v1 only soft-deleted accounts with a NULL `email_confirmed_at`, on the assumption that a real
-- account eventually confirms its email and a bot never does. That assumption is simply false for
-- every phone-OTP signup in this app: the synthetic placeholder email is auto-confirmed the
-- moment the account is created, real user or not. 0 of docs/HANDOVER/85's 4,499 confirmed-bot
-- accounts had a null `email_confirmed_at` — this filter would have protected every single one of
-- them from ever being purged, forever, even if the detection signals above had fired correctly.
--
-- v2 replaces that proxy with a direct check of the one thing that actually matters: does this
-- specific referred account have ANY real financial or platform footprint? An account is only
-- ever soft-deleted if ALL of the following hold:
--   - zero general_ledger rows (not "net zero" — literally zero rows; an account with even a
--     single administrative correction, like docs/HANDOVER/85's "gh" account, is left frozen but
--     NOT erased, for a human to look at, rather than have this function guess whether a ledger
--     row is "real")
--   - wallet balance is zero (or no wallet row at all)
--   - zero withdrawal_requests
--   - zero house_listings (as agent or landlord)
--   - zero agent_collections
--   - no rent_requests that ever left service_center_review/cancelled/rejected (never funded)
-- This is evaluated PER ACCOUNT, not per referrer: a referrer's cohort can and does contain a mix
-- of confirmed bots and real people who happened to sign up through a bad-actor's referral link
-- (docs/HANDOVER/39 found exactly this — 9 real people mixed into a 70-account burst). Only the
-- zero-activity accounts are erased; anyone with real activity is left completely alone, even
-- though their referrer gets frozen.
--
-- `general_ledger` is never written to by this function, in either version. Freezing and
-- soft-deleting are both reversible (`fraud_identity_blocks.status`, `admin_restore_soft_deleted_
-- account()`); nothing here is a hard DELETE.
--
-- =============================================================================================
-- WHAT IS DELIBERATELY STILL OUT OF SCOPE — don't assume this function does these
-- =============================================================================================
--
-- - Referral-bonus money already paid out to a fraud referrer is NEVER clawed back by this
--   function. docs/HANDOVER/85's 53 referrers show UGX 10.9M in referral-tagged ledger rows that
--   mix real and fraudulent earnings inseparably at the SQL level — that split needs a human
--   FinOps trace against the `referrals` table per referrer, every time. Automating a clawback
--   here would risk debiting money a referrer legitimately earned.
-- - A bot ring with NO referrer_id at all still has nothing for this function to group by. It
--   remains a real, undetected gap — flagged again, not solved, same as v1's own "Known limits".
-- - A ring spread across many low-volume referrer identities (each individually under 15
--   lifetime referred accounts) still won't trip the referred_count threshold. Removing the time
--   window closes the "spread over time" evasion; it does not close the "spread over many
--   identities" evasion. That would need a device/IP-fingerprint signal this schema doesn't
--   currently capture at signup.

ALTER TABLE public.bot_referral_ring_detections
  ADD COLUMN IF NOT EXISTS low_quality_name_count integer,
  ADD COLUMN IF NOT EXISTS detection_signal text,
  ADD COLUMN IF NOT EXISTS bots_preserved_for_review integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.bot_referral_ring_detections.detection_signal IS
  'Which v2 signal fired: name_reuse (distinct/referred < 0.4, the original v1 signal), low_quality_names (>= 50% of names are individually gibberish/too-short/placeholder, closes the docs/HANDOVER/85 blind spot), or both.';
COMMENT ON COLUMN public.bot_referral_ring_detections.bots_preserved_for_review IS
  'Referred accounts under this referrer that were NOT soft-deleted because they have real financial/platform activity (general_ledger, wallet balance, withdrawal_requests, house_listings, agent_collections, or a funded rent_request). The referrer is still frozen; these specific accounts are left completely untouched.';

CREATE OR REPLACE FUNCTION public.scan_and_quarantine_bot_referral_rings()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6'; -- Josh Wanda, standing authorization, unchanged from v1
  v_reason text;
  v_signal text;
  r RECORD;
  v_bot_ids uuid[];
  v_bot_count int;
  v_preserved_count int;
  v_detections int := 0;
  v_frozen int := 0;
  v_purged int := 0;
  v_preserved_total int := 0;
BEGIN
  FOR r IN
    -- No time window on the cohort (blind spot #1) -- a referrer's ENTIRE history is considered
    -- every scan.
    --
    -- Deliberately NOT filtered to "referrer not frozen" here. An earlier draft of this function
    -- (deployed and caught live within the same session) did add that filter, reasoning that an
    -- already-frozen referrer must already be "handled" -- but that's exactly the same class of
    -- assumption that let v1's ring survive undetected for 7 months: two referrers frozen by
    -- earlier, unrelated manual cleanups (`kagwa hassan`, `MUHANGUZI MICHEAL`) had NEVER actually
    -- had their bot cohorts purged, because v1's purge step used the broken `email_confirmed_at`
    -- filter (see header). Filtering the scan on `is_frozen` would have made this same mistake
    -- permanent for any referrer frozen by a process other than this function. The set still
    -- self-limits without that filter: once a referrer's entire LIVE bot cohort is purged, their
    -- live `referred_count` (via the `deleted_at IS NULL` filter below) drops below the detection
    -- threshold and they stop appearing here on their own.
    WITH cohort AS (
      SELECT p.id, p.referrer_id, p.full_name, p.created_at, u.email
      FROM public.profiles p
      LEFT JOIN auth.users u ON u.id = p.id
      WHERE p.deleted_at IS NULL AND p.referrer_id IS NOT NULL
    ),
    quality AS (
      SELECT c.*,
        trim(c.full_name) AS name_trim,
        lower(trim(c.full_name)) AS name_lc
      FROM cohort c
    ),
    tagged AS (
      SELECT q.*,
        (
          name_trim = ''
          OR length(name_trim) <= 2
          OR name_lc ~ '^(.)\1+$'
          OR name_trim ~ '^[0-9 ]+$'
          OR (name_lc ~ '^[^aeiou\s]+$' AND length(name_trim) > 3)
          OR name_lc ~ '(test|testing|demo|sample|dummy|placeholder|unknown|n/?a\b|none|asdf|qwerty|xxx+|fake|temp)'
        ) AS is_low_quality_name
      FROM quality q
    ),
    agg AS (
      SELECT
        t.referrer_id,
        count(*) AS referred_count,
        count(DISTINCT t.full_name) AS distinct_names,
        count(*) FILTER (WHERE t.is_low_quality_name) AS low_quality_count,
        count(*) FILTER (
          WHERE t.email LIKE '%@welile.agent' OR t.email LIKE '%@welile.user' OR t.email LIKE '%@noapp.welile.user'
        ) AS synthetic_email_count,
        min(t.created_at) AS first_seen,
        max(t.created_at) AS last_seen
      FROM tagged t
      GROUP BY t.referrer_id
    )
    SELECT a.*,
      rp.is_frozen AS referrer_already_frozen,
      extract(epoch FROM (a.last_seen - a.first_seen)) / 3600.0 AS span_hours,
      (a.distinct_names::numeric / a.referred_count) < 0.4 AS signal_name_reuse,
      (a.low_quality_count::numeric / a.referred_count) >= 0.5 AS signal_low_quality
    FROM agg a
    JOIN public.profiles rp ON rp.id = a.referrer_id
    WHERE a.referred_count >= 15
      AND (
        (a.distinct_names::numeric / a.referred_count) < 0.4          -- signal A: v1's original, still validated
        OR (a.low_quality_count::numeric / a.referred_count) >= 0.5   -- signal B: new, closes blind spot #2
      )
      -- Deliberately NO synthetic-email requirement here (blind spot #3) -- see header.
  LOOP
    v_signal := CASE
      WHEN r.signal_name_reuse AND r.signal_low_quality THEN 'both'
      WHEN r.signal_name_reuse THEN 'name_reuse'
      ELSE 'low_quality_names'
    END;

    v_reason := format(
      'Automated bot-referral-ring hunter v2: %s referred accounts (all-time, live), %s distinct name(s), %s%% individually low-quality names, %s%% synthetic email. Signal: %s. Detected %s.',
      r.referred_count, r.distinct_names,
      round(r.low_quality_count::numeric / r.referred_count * 100, 0),
      round(r.synthetic_email_count::numeric / r.referred_count * 100, 0),
      v_signal, now()
    );

    IF NOT r.referrer_already_frozen THEN
      PERFORM public.fraud_block_user_identifiers(r.referrer_id, v_reason, v_actor);
      v_frozen := v_frozen + 1;
    END IF;

    -- Purge eligibility (blind spot in v1's purge step): zero real financial/platform footprint,
    -- checked directly, not inferred from email confirmation. Anyone with real activity is left
    -- completely untouched even though their referrer is now frozen. Computed once per account
    -- as `has_activity` so the two outcomes (purge vs. preserve) can never drift out of sync.
    WITH cohort_accounts AS (
      SELECT p.id,
        EXISTS (SELECT 1 FROM public.general_ledger gl WHERE gl.user_id = p.id)
        OR EXISTS (SELECT 1 FROM public.wallets w WHERE w.user_id = p.id AND w.balance <> 0)
        OR EXISTS (SELECT 1 FROM public.withdrawal_requests wr WHERE wr.user_id = p.id)
        OR EXISTS (SELECT 1 FROM public.house_listings hl WHERE hl.agent_id = p.id OR hl.landlord_id = p.id)
        OR EXISTS (SELECT 1 FROM public.agent_collections ac WHERE ac.agent_id = p.id)
        OR EXISTS (
          SELECT 1 FROM public.rent_requests rr
          WHERE (rr.tenant_id = p.id OR rr.agent_id = p.id OR rr.landlord_id = p.id)
            AND rr.status NOT IN ('service_center_review', 'cancelled', 'rejected')
        ) AS has_activity
      FROM public.profiles p
      WHERE p.deleted_at IS NULL AND p.referrer_id = r.referrer_id
    )
    SELECT
      array_agg(id) FILTER (WHERE NOT has_activity),
      count(*) FILTER (WHERE has_activity)
    INTO v_bot_ids, v_preserved_count
    FROM cohort_accounts;

    v_bot_count := COALESCE(array_length(v_bot_ids, 1), 0);
    v_preserved_count := COALESCE(v_preserved_count, 0);

    IF v_bot_count > 0 THEN
      INSERT INTO public.deleted_accounts (user_id, full_name, email, phone, national_id, roles, status, reason, deleted_by)
      SELECT p.id, p.full_name, p.email, p.phone, p.national_id,
             COALESCE(
               (SELECT jsonb_agg(jsonb_build_object('role', ur.role, 'enabled', true))
                FROM public.user_roles ur WHERE ur.user_id = p.id),
               '[]'::jsonb
             ),
             'soft_deleted',
             v_reason || ' Referred by ' || r.referrer_id::text || '.',
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
        frozen_reason = 'Account deleted: automated bot-referral-ring hunter v2, ' || now()::text,
        deleted_at = now(), deleted_by = v_actor,
        deletion_reason = v_reason
      WHERE p.id = ANY(v_bot_ids);

      INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
      SELECT v_actor, 'soft_delete_account', 'soft_delete_account', 'profiles', bot_id::text,
        jsonb_build_object('reason', v_reason, 'performed_by', v_actor, 'automated', true, 'referrer_id', r.referrer_id, 'hunter_version', 'v2')
      FROM unnest(v_bot_ids) AS bot_id;
    END IF;

    v_purged := v_purged + v_bot_count;
    v_preserved_total := v_preserved_total + v_preserved_count;
    v_detections := v_detections + 1;

    INSERT INTO public.bot_referral_ring_detections (
      referrer_id, referred_count, distinct_names, synthetic_email_count, low_quality_name_count,
      span_hours, action_taken, bots_soft_deleted, bots_preserved_for_review, detection_signal, notes
    ) VALUES (
      r.referrer_id, r.referred_count, r.distinct_names, r.synthetic_email_count, r.low_quality_count,
      r.span_hours,
      CASE
        WHEN v_bot_count = 0 THEN 'skipped_already_handled'
        WHEN r.referrer_already_frozen THEN 'already_frozen_purged_new'
        ELSE 'frozen_and_purged'
      END,
      v_bot_count, v_preserved_count, v_signal, v_reason
    );
  END LOOP;

  RETURN jsonb_build_object(
    'scanned_at', now(),
    'hunter_version', 'v2',
    'rings_detected', v_detections,
    'referrers_newly_frozen', v_frozen,
    'bot_accounts_purged', v_purged,
    'accounts_preserved_for_review', v_preserved_total
  );
END;
$function$;

-- Cron schedule is unchanged (same job name -> CREATE OR REPLACE on the function is enough,
-- no need to re-schedule).

-- =============================================================================================
-- RESULTS — applied directly to production 2026-09-19, then manually invoked twice (the second
-- time after the is_frozen scanning bug above was found and fixed) rather than waiting up to 30
-- minutes for the cron. Recorded here so the historical backlog cleanup has a permanent record
-- outside of bot_referral_ring_detections alone.
-- =============================================================================================
--
-- Run 1 (initial deploy):  11 rings detected, 2,376 bot accounts purged, 0 preserved for review.
-- Run 2 (after the fix):    2 rings detected (both previously frozen by unrelated cleanups,
--                           `kagwa hassan` and `MUHANGUZI MICHEAL` -- see the note above),
--                           1,014 more bot accounts purged, 1 preserved for review.
-- Run 3 (convergence check): 0 rings detected, 0 purged -- confirms the function is idempotent
--                           and has fully cleared the currently-detectable backlog.
--
-- Total: 13 referrers actioned, 53 referrer-level fraud_identity_blocks rows now exist matching
-- these detections (some already existed from earlier, unrelated manual work), 3,390 accounts
-- soft-deleted, 2 preserved for human review (real activity found under an otherwise-confirmed
-- fraud referrer). Verified post-run: zero general_ledger rows were written or modified by either
-- run; deleted_accounts and audit_logs both show exactly 3,390 matching rows.
--
-- This does NOT purge every account flagged in docs/HANDOVER/85's broader, looser scan (which
-- used "referrer has >=15 flagged-name accounts" with no ratio-to-total requirement). Several
-- thousand more gibberish-named accounts remain live under referrers whose garbage-name fraction
-- of their TOTAL referred cohort stays under 50% (e.g. a referrer with 1,181 total referred and
-- 138 garbage-named -- 11.7% -- reads as a real high-volume agent with some messy signups mixed
-- in, not a ring, and this function deliberately leaves that ambiguous case alone rather than
-- risk freezing a legitimate agent). That remaining pool needs the same individual human review
-- doc 23 always called for on ambiguous cases -- this function was never meant to replace that,
-- only to stop the unambiguous, high-concentration cases from surviving for months unchecked.
--
-- The standalone one-off migration this rebuild was meant to supersede
-- (20260919150000_purge_multi_month_gibberish_name_referral_ring.sql) is now redundant for the
-- accounts it targeted -- most were already purged by this function's first run. Its own
-- pre-flight count assertion (53 referrers / 4,499 bots) will correctly refuse to run again now
-- that the underlying data has changed; that is the assertion working as designed, not a bug.
-- Left in the repo unmodified as a record of the original manual investigation.

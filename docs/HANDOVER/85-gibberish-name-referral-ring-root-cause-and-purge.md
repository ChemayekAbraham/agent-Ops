# 85. Root cause + purge — the multi-month gibberish-name referral ring

**Read this before touching `scan_and_quarantine_bot_referral_rings` (doc 23) again, before
trusting it as complete coverage, and before running
`20260919150000_purge_multi_month_gibberish_name_referral_ring.sql`.**

## What was asked

Josh flagged three of the "vague/unrealistic name" buckets from the profile-quality scan (no
vowels, too short, repeated character — 4,776 of the 4,838 total flagged profiles) and asked for
three things: trace how they got in, kill the entry point, then find a way to remove them without
touching the ledger.

## Trace — how they got in

**Entry point:** the general public phone-OTP signup path (`useAuthForm.ts` →
`supabase.auth.signUp()`), the same door doc 21/22 already document, carrying a `referrer_id`.
Every flagged account in this ring has the synthetic placeholder email pattern
`<phone>@noapp.welile.user` used by that path — these are real phone numbers going through real
signup, not a spoofed-data dump.

**Scale, once traced by referrer:** 4,781 of the 4,838 originally-flagged accounts have a
`referrer_id` set, concentrated behind just **128 distinct referrers**. Grouping by referrer and
keeping only those with **15+ flagged referrals** (the same threshold doc 23's hunter already
uses) isolates **53 referrers → 4,499 garbage-named accounts**, spanning **2026-02-11 to
2026-09-14** — seven months, not a single burst.

**Why this earned money, not just clutter:** doc 21 already found `get_referral_progress()` had
been silently gutted to `v_qualified := v_signed_up` — bare signup alone qualified the referrer
for a bonus, no milestone required. That bug was live for at least the Aug 10 → Sept-something
window (confirmed present in the `20260810080254` migration; confirmed **absent** from the current
live function). Every one of these 4,499 signups hit `try_credit_qualified_referrals()` the same
way the original 25,732-account ring did.

**Why the standing hunter (doc 23) never caught it — three separate blind spots, not one:**

1. **48-hour scan window.** Anything older survives indefinitely — doc 39 already found this gap
   for the 2026-08-18 burst; this is the same gap at much larger scale.
2. **Name-diversity signal inverted for this ring.** The hunter's `distinct_names / referred_count
   < 0.4` check assumes a bot reuses 1-2 fixed names (true for OKIROR ANDREW's `"morning"` /
   `"morning too"` ring, doc 39 finding 2). This ring instead generates a **unique random
   keyboard-mash per account** — 97%+ name diversity within the flagged cohort — which reads to the
   hunter as ordinary distinct real users. High name diversity is not, on its own, evidence of
   anything; it just happens to be exactly what this generator produces.
3. **Purge step requires `email_confirmed_at IS NULL`.** Checked directly: **0 of 4,499** target
   accounts have a null `email_confirmed_at` — phone-OTP signups get their synthetic placeholder
   email auto-confirmed at creation. Even a ring that *did* trip the volume + diversity signals
   would never actually get purged by the standing function if it came in through this path,
   because its own filter excludes every phone-OTP account by construction.

**What's already closed, verified live, not just documented:**

- `20260914170000_harden_signup_velocity_guard.sql` (2026-09-14) caps new signups to 5/hour or
  10/day per referrer. Checked directly: **zero** new accounts under any of these 53 referrers
  since 2026-09-14 17:00 UTC (5 days as of this writing) — the entry point is shut for this exact
  shape of abuse.
- `get_referral_progress()`'s bare-signup bug is confirmed gone from the live function body.

**What's still open (not fixed here — flagged for a decision, not applied unilaterally):**
blind spots #2 and #3 above mean a **slow-drip** version of this same tactic — one that stays
under the new 5/hour-10/day cap — would still sail past the standing hunter forever, on both the
diversity check and the email-confirmed filter. A real fix needs: (a) a name-quality signal
independent of reuse (e.g. flag high-entropy/vowel-less names directly, the same regex used for
this investigation, rather than relying on repetition), and (b) dropping or loosening the
`email_confirmed_at IS NULL` requirement for the phone-OTP synthetic-email pattern specifically,
since that pattern's "confirmed" status carries no signal either way. Not touched in this pass —
changing a standing, unattended fraud-detection function's thresholds is exactly the kind of
change doc 23 warns against making without a human sign-off first.

## Verified safe to remove — no ledger impact

Checked directly against production for all 4,499 target accounts before writing the purge:

| Check | Result |
|---|---|
| Wallet balance (sum) | **UGX 0** |
| `house_listings` (agent or landlord) | **0** |
| `agent_collections` | **0** |
| `withdrawal_requests` | **0** |
| `rent_requests` reaching a funded/active status | **0** (193 rows exist, all stuck at `service_center_review`/`cancelled`/`rejected` — never funded, never disbursed) |
| `general_ledger` rows | **2** — a single net-zero (`+5,000` / `-5,000`) admin correction dated 2026-04-10 that zeroed an already-known orphaned wallet on account "gh"; not real financial activity |

Nothing here is reachable from `general_ledger` in a way that purging the profile would disturb.

## What's deliberately NOT resolved here — the referral-bonus money

The 53 referrer accounts collectively show **33,318 `general_ledger` rows** with
`description ILIKE '%referral%'`, totalling **UGX 10,931,000**. This is **not** presented as fraud
proceeds — these same 53 accounts show far more total referred users (hundreds each in several
cases) than garbage-named ones, so a real portion of that total is legitimate earned income from
real referrals. Separating "bonus paid for a confirmed-bot referral" from "bonus paid for a real
one" requires a row-level join against the `referrals` table per referrer, which is a genuine
FinOps trace, not an automated split — same precedent as the OKIROR ANDREW ring (doc 39 finding 2,
UGX 382,200, still unresolved). **Flagging this for Josh's call, not attempting it here.**

## The purge

`supabase/migrations/20260919150000_purge_multi_month_gibberish_name_referral_ring.sql` —
same reversible mechanism already used twice (doc 39's manual purge, and the standing hunter):

1. Re-derives the exact 53-referrer / 4,499-bot selection from first principles inside the
   migration (not a hardcoded ID list) and **aborts via `RAISE EXCEPTION`** if the count doesn't
   match 53/4,499 exactly, or if any target account now shows a non-zero wallet balance, a
   withdrawal request, or a funded rent_request — re-verified inside the same transaction, not
   trusted from the investigation alone.
2. Freezes the 47 not-already-frozen referrers via `fraud_block_user_identifiers()` (6 of the 53
   are already frozen from earlier, unrelated cleanups).
3. Soft-deletes the 4,499 bot accounts using the identical shape `admin_soft_delete_account()` /
   the standing hunter use: `deleted_accounts` insert, PII scrub (name, email, phone, national ID,
   mobile money number), `is_frozen = true`, `deleted_at`/`deletion_reason` set, `user_roles` and
   `push_subscriptions` rows removed, one `audit_logs` row per account.
4. Logs one row per referrer into `bot_referral_ring_detections` (the same table the standing
   hunter writes to) tagged `frozen_and_purged_manual_backfill`, so this shows up in the one place
   ops already knows to check rather than only in this doc.
5. **`general_ledger` is never referenced as a write target anywhere in this migration.**

**Not yet applied.** Given the scale (4,499 accounts, 47 freezes) this needs Josh to run it by hand
via the Supabase SQL editor, same as doc 39's smaller purge — expect the auto-mode classifier to
refuse a direct `query_database` attempt at this size as an unverifiable/high-blast-radius
deletion.

## Verify after running

```sql
-- Expect 4,499
select count(*) from public.deleted_accounts
where reason ilike '%Manual review 2026-09-19: multi-month gibberish-name referral ring%';

-- Expect 47 (the 6 already-frozen referrers won't show a fresh fraud_identity_blocks row)
select count(*) from public.fraud_identity_blocks
where reason ilike '%Manual review 2026-09-19: multi-month gibberish-name referral ring%';

-- Expect 0 rows -- confirms none of the target accounts still have a live profile
select count(*) from public.profiles
where deleted_at is null
  and id in (select user_id from public.deleted_accounts
             where reason ilike '%Manual review 2026-09-19: multi-month gibberish-name referral ring%');

-- Confirm general_ledger is untouched -- row count for the two known rows should be exactly 2, unchanged
select count(*) from public.general_ledger
where user_id = 'e2a286e8-03f9-4dac-8717-962311ab252c';
```

## What not to do

- Don't re-run the purge migration if the pre-flight count assertion fails — that means the
  underlying data moved since this investigation (e.g. someone already partially cleaned this up,
  or a referrer crossed back under the 15-referral threshold because some bots were already
  removed by something else). Re-investigate before forcing it through.
- Don't touch the 53 referrers' `general_ledger` rows or attempt an automated referral-bonus
  clawback — that's explicitly out of scope here and needs a human FinOps decision, same as
  OKIROR ANDREW.
- Don't lower `scan_and_quarantine_bot_referral_rings`'s thresholds to "catch this next time"
  without addressing the actual gaps found here (the diversity signal and the
  `email_confirmed_at` filter) — a naive threshold change doesn't fix either blind spot and risks
  the false-positive regression doc 23 already warns about.

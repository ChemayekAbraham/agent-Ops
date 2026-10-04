# 21 — Referral-bonus bot-signup fraud ring

**Read this before touching `get_referral_progress`, `try_credit_qualified_referrals`,
`fraud_identity_blocks`, or `admin_soft_delete_account`.**

## What was found

The CTO dashboard's Fake Account Radar flagged ~25,500 accounts as `burst_signup`
(`cto_fake_account_base()`: 10+ signups from the same `referrer_id` inside the same
10-minute bucket, all with unconfirmed email). Investigating why they existed led to an
active, quantified financial exploit, not just spam. **Final scope after three extension
passes: 24 confirmed fraud referrer accounts, ~34,311 bot accounts.**

- **17 referrer accounts** drove **25,732** throwaway signups between 2026-09-10 and
  2026-09-13 (one referrer alone: 3,315 signups in ~2.5 days — no human does that).
- Every referred bot got all four personas (`tenant`, `agent`, `landlord`, `supporter`)
  inserted in `user_roles` at the exact same millisecond as signup — a real user only
  ever gets the one persona they pick. This is the tell that separates a bot from a
  legitimately dormant/unverified real user (the other ~58,000 "flagged" accounts on
  the dashboard, mostly just `dormant`/`unverified_email` alone, were **not** touched —
  see "What was deliberately left alone" below).
- Each of the 25,732 bots triggered `try_credit_qualified_referrals()`, which pays the
  referrer UGX 100 the moment `get_referral_progress()` returns `qualified: true`.
- **Root cause**: `get_referral_progress()` had been silently gutted from a real
  per-persona milestone gate down to `v_qualified := v_signed_up` — bare signup, no
  activity required at all — across three migrations on the same day, 2026-08-10:

  | Time (UTC) | Migration | What `qualified` required |
  |---|---|---|
  | 07:44 | `63dee98e` | Real: agent needs 1 verified house + 1 funded rent request; tenant needs 1 funded rent request; funder needs 1 active portfolio; landlord needs 1 verified landlord record |
  | 07:50 | `2fc953bb` | Weakened: "first real milestone of any kind" |
  | 08:02 | `e60cef66` | **Gutted: `v_qualified := v_signed_up`** — this is what was live until this fix |

  The scaffolding computing `houses_verified`, `rent_approved_paid`, `portfolios_active`
  etc. was still all there and still correct — every `*_required` field had just been
  hardcoded to `0`. It looked like a real gate and wasn't one, for over a month.

- **Money already moved**: UGX 3,282,700 in `referral_bonus` credits paid to the first
  17 referrers, of which **UGX 3,172,500 was already withdrawn** (cashed out via mobile
  money) before this was caught. Only UGX 240,800 was still sitting in wallets.
- The 25,732 bot accounts themselves held **zero** wallet balance, zero
  `general_ledger` rows, zero `rent_requests` — confirmed before touching anything.
  They were pure signup-farm shells; all the money sat with the 17 referrers.

### It didn't stop there — two follow-ups the same day

After the first fix and cleanup, two things surfaced:

1. **Freezing a referrer's own account does not stop their script.** One of the 17
   already-frozen referrers (`fc7837ea...`) kept producing new bot signups for hours
   afterward — `is_frozen` blocks *withdrawals*, it doesn't stop new `auth.users`
   rows from being created with that `referrer_id`. The root-cause fix already made
   this financially pointless, but the accounts kept getting created.
2. **Auditing every account with 10+ `referral_bonus` credits (not just what the
   `burst_signup` heuristic had flagged) found 2 more referrers running the identical
   pattern** — 400 bonuses / UGX 40,000 each — and **~7,859 additional bot accounts**
   under all 19 referrers combined that `burst_signup` had missed entirely.
   `burst_signup` only fires on 10+ signups in the *same 10-minute bucket*; a slower
   drip (one signup every 1-2 minutes for hours, same referrer, same email pattern)
   evades it completely even though it's obviously the same ring.

**Final totals across all 19 referrers**: UGX 3,362,700 paid, UGX 3,172,500 already
withdrawn, **UGX 320,800 recovered** by freezing before it could be cashed out (the 2
new referrers hadn't withdrawn yet). ~33,591 bot accounts soft-deleted in total.

A **real-time guard was added to `handle_new_user()`** (the trigger that fires on
every `auth.users` insert, not app code) — 15+ signups from the same `referrer_id` in
the last hour is now rejected outright at the database level. This is the one part of
the fix that cannot be bypassed by hitting Supabase Auth's public `/auth/v1/signup`
endpoint directly, because it fires regardless of which client created the row.

## What was fixed

1. **Root cause** — `20260914140000_restore_referral_bonus_milestone_requirement.sql`
   restores the 2026-08-10 07:44 real milestone gate verbatim. A signup script cannot
   satisfy any of the four persona requirements — each needs Ops-verified data or
   actual funded money movement. Verified live immediately: calling
   `get_referral_progress()` on a known bot now returns `qualified: false`.

2. **The 17 referrer accounts were frozen**, not deleted — via the existing
   `fraud_block_user_identifiers(user_id, reason, blocked_by)` (already used elsewhere
   in this codebase; nothing new was built for this). This sets
   `profiles.is_frozen = true` and blocks every identifier the account has ever used
   for payouts (phone, mobile money number, email, national ID, full name). The
   pre-existing trigger `enforce_no_fraud_withdrawal_request()` already checks
   `is_frozen` and now blocks any further withdrawal from these 17 — this is what
   actually stops the remaining UGX 240,800. Fully reversible: `status` on
   `fraud_identity_blocks` and `is_frozen` on `profiles` can both be released.

3. **The 25,732 bot accounts were soft-deleted**, not hard-deleted — same pattern as
   `admin_soft_delete_account()` (registers in `deleted_accounts`, redacts
   name/email/phone/national_id, drops `user_roles` and `push_subscriptions`, sets
   `profiles.deleted_at`/`is_frozen`). Applied as raw SQL in
   `20260914141000_fraud_referral_bot_signup_ring_remediation.sql` rather than by
   calling the RPC directly, because that RPC requires an authenticated staff
   `auth.uid()` session, which a migration doesn't have — `deleted_by` is set to Josh
   Wanda's real `user_id` for audit attribution instead. Fully reversible via
   `admin_restore_soft_deleted_account()`.

## What was deliberately left alone

- The broader ~83,000-account "flagged" bucket on the dashboard (anything scoring
  `risk_score > 0`) was **not** touched. Most of that is `dormant` (56,823 — a real
  person who signed up and never came back) or `unverified_email` alone (26,250) —
  both weak, single-signal heuristics that will catch real users. Only the
  `burst_signup` cohort was acted on, because it had a second, independent,
  concrete corroborating signal (the all-four-roles-at-once anomaly) and a clear
  money trail.
- No `general_ledger` rows were altered or deleted — the referral bonus payouts and
  the referrers' withdrawals are real, already-happened transactions and stay in the
  ledger as history. The 17 accounts are frozen going forward; nothing already
  recorded was reversed.

## Still open

- The ~UGX 3.17M already withdrawn by the referrers has left the platform via
  mobile money — this is a recovery/legal question for Josh, not a database fix.
- This was found via the **referrer's** wallet/ledger activity. The same
  `try_credit_qualified_referrals()` path exists for every other referral reward
  mechanism in this codebase (`landlord_ambassador_referrals`,
  `merchant_agent_referrals`, `supporter_referrals`) — none of those were audited in
  this pass. Worth the same check.
- **The broader "all four roles at once" signal was re-measured and mostly ruled
  out.** The original 8,798-account / 84-referrer figure used the wrong proxy: it
  missed bot rings that set the role field correctly (evading that exact signature)
  and would have wrongly implicated real agent-driven growth — one referrer in that
  pool, `864b1df4...`, turned out to be a genuine agent with 1,456 real
  sub-agent/customer signups via the normal `@welile.agent` synthetic-email pattern
  (99% synthetic emails, 1,456 distinct phone numbers, 1,297 distinct real names,
  spread over 44 days). Left untouched.

  Re-measuring on total-referred-count + time concentration + **name/email
  diversity** (a bot cohort reuses one or two fake names across hundreds of rows; a
  real agent's cohort has mostly distinct names) found **5 more confirmed
  referrers** running the identical incrementing-digit-email pattern as the original
  19 — Asiime Meresi (383 bots), Lubega Twaha (199), Aniwar Ssempijja (63), Isa Kato
  (54), Seez Records (21). All 5 frozen, 720 referred bot accounts soft-deleted
  (`20260914160000_fraud_ring_sweep_second_extension.sql`). Two more matching the
  same signature (Ampire Tobbi, Mucunguzi Eliias) were already frozen — caught
  incidentally because they'd themselves been referred by one of the original 19.

  A much larger pool — **256 referrers / ~54,000 accounts / UGX 17.4M bonus paid /
  UGX 157M withdrawn** — was measured with a looser filter and is **not** confirmed
  fraud; per the `864b1df4` check, that pool is dominated by real agent activity.
  Each one needs the same individual name/email-diversity verification before any
  action — a blanket sweep of it would freeze real agents' real earned money.
- `preflightSignup()` / `record_signup_attempt` (client-side-only, bypassable by
  calling Supabase Auth's public `/auth/v1/signup` REST endpoint directly) is still
  the *first* line of defense and still bypassable that way. The signup-velocity
  guard added to `handle_new_user()` (see above) is the real backstop now — it
  can't be bypassed by skipping the client — but it only catches referrer-driven
  velocity, not a bot ring that signs up with no `referrer_id` at all. A
  CAPTCHA/Turnstile gate on Supabase Auth's own signup endpoint is still the more
  complete fix and hasn't been done.

## Verify this is still fixed

```sql
-- Should return qualified: false for a bare-signup account with no real activity.
select public.get_referral_progress('<any just-signed-up user_id>'::uuid);

-- Should be zero going forward (existing rows from before the fix stay, correctly, as history).
select count(*) from public.cto_fake_account_base() where burst_signup;

-- The 17 referrers should still show is_frozen = true.
select count(*) from public.profiles
where is_frozen and frozen_reason ilike '%referral-bonus bot-signup ring%';
```

## What not to do

- Don't hard-delete `profiles` or `auth.users` rows for accounts like these — the
  soft-delete pattern (`deleted_accounts` register + redaction) is the only one this
  codebase uses, and it's reversible. A hard delete is not.
- Don't re-run the milestone weakening from 2026-08-10 "to make onboarding metrics
  look better" — that's exactly what created this hole. If the persona-milestone
  bar needs adjusting, adjust the threshold, don't remove it.
- Don't assume every `burst_signup`-flagged account going forward is automatically
  safe to soft-delete without checking money exposure first, the way this pass did.

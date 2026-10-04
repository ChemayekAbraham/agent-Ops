# 31 — Dormant-referral-shell guard (second, earlier bot-signup ring)

**Read this before touching `scan_and_quarantine_dormant_referral_shells`, or before
trusting `scan_and_quarantine_bot_referral_rings` (doc 23) as complete coverage.**

## What was found

Reviewing the CTO Fake Account Radar (`cto_fake_account_base()`) at Josh's request turned
up a second referral-bonus bot ring, earlier and larger than the one in doc 21, that the
existing automated hunter (doc 23) cannot see and never will, structurally:

- **43 referrer accounts**, each with 200–1,128 referred signups bearing a distinct
  gibberish single-word name per row (`uyte`, `nsbdb`, `gjsg`...), concentrated in bursts
  on **2026-07-07 to 2026-07-23** (one day alone: 7,706 signups).
- Every referred account uses the platform's own `@welile.agent` synthetic-email pattern
  with `email_confirmed_at` set — which is exactly why the radar's `unverified_email` and
  `burst_signup` flags never fire (both require a *non-synthetic, unconfirmed* email), and
  why `scan_and_quarantine_bot_referral_rings` never fires either: its two guardrails are
  "distinct_names / referred_count < 0.4" and "synthetic_email_count / referred_count <
  0.5" — this ring has ~90%+ name diversity (a different gibberish string per row) and
  ~96%+ synthetic-domain email, so it fails both checks and reads as a legitimate
  high-volume agent onboarding cohort. It also predates that hunter's 48-hour scan window
  by months.
- **40 of the 43** referrers show **zero** `general_ledger` rows and **zero**
  `rent_requests` across their entire referred cohort — the identical "pure signup-farm
  shell" signature doc 21 used to clear the original ring. (3 referrers — `ae474e60...`,
  `dd7e88ae...`, `5df3fcbc...` — have real `rent_requests` under their cohort and were
  excluded; they read as genuine high-volume agents.)
- Money: **UGX 5,760,100** in `referral_bonus` credited to the 39 still-active (not
  already frozen) referrers in this cluster, almost entirely in the window
  2026-07-07–2026-07-23 — **before** the 2026-08-10 `get_referral_progress` gutting that
  doc 21's fix addressed. The mechanism was a separate, earlier code path
  (`credit_signup_referral_bonus`, live migrations `20260617080333` →
  `20260805083237`) that paid "your invite signed up" / "someone signed up using your
  shared link" bonuses on bare signup with **no milestone gate at all**. That specific
  path is already closed — the live `credit_signup_referral_bonus()` is now just
  `PERFORM try_credit_qualified_referrals(...)`, which is properly gated — so this is
  historical exposure, not a currently-open hole via that mechanism.
- Current wallet balances on the 39 referrers are effectively zero (0–10,000 UGX each) —
  the bonus money is already cashed out via mobile money, same pattern as doc 21.
- 4 of the 43 referrers were already frozen incidentally (caught by some other sweep).

## What was built

`20260916100000_dormant_referral_shell_guard.sql` adds
`scan_and_quarantine_dormant_referral_shells(p_min_referred int default 50,
p_max_active_ratio numeric default 0.05, p_lookback interval default '45 days')`,
`security definer`, granted only to `service_role`/`postgres` (same as doc 23's function
— never exposed to `authenticated`).

Unlike doc 23's hunter, this one does **not** use name diversity or email domain as the
signal at all. It computes, per referrer, what fraction of their referred cohort (within
`p_lookback`) has **any** footprint anywhere else in the system — a `general_ledger` row,
a `rent_requests` row (as tenant or agent), a `house_listings` row, a `landlords` or
`lc1_chairpersons` registration, or an `investor_portfolios` row (the same signals
`get_referral_progress` checks). A referrer with `referred_count >= 50` and an activity
ratio `<= 5%` gets frozen via `fraud_block_user_identifiers` (reversible, same as doc 21);
every individually-zero-activity account in their cohort gets soft-deleted using the exact
same pattern as `scan_and_quarantine_bot_referral_rings` (register in `deleted_accounts`,
redact PII, `is_frozen`/`deleted_at` on `profiles`, `audit_logs` row) — **not** a blanket
delete of everyone that referrer ever referred, so the 3 legitimate high-volume agents in
this pass, or anyone else who mixes real referrals with a few dormant ones, are not
touched.

Registered on the same `*/30 * * * *` cron cadence as doc 23's hunter, as a second job
(`scan-and-quarantine-dormant-referral-shells`), so both run independently going forward.

## Still needs doing — this session could not finish it

This session's write access is sandboxed: direct DDL/cron writes against the production
database (via `mcp__lovable__query_database`) and even a local `supabase --version` /
`grep` shell check were blocked by the auto-mode permission classifier as "Modify Shared
Resources." The function above exists **only as a migration file in this branch** — it
has **not** been created in production, the cron job has **not** been registered, and the
43-referrer backlog has **not** been swept yet.

To finish this:

1. **Deploy the migration** (`20260916100000_dormant_referral_shell_guard.sql`) to
   production the normal way — push and verify it actually landed, per the standing
   gotcha that pushed migrations sometimes silently never apply. Confirm with:
   ```sql
   select proname from pg_proc where proname = 'scan_and_quarantine_dormant_referral_shells';
   select jobid from cron.job where command ilike '%dormant_referral_shells%';
   ```
2. **Run one backfill pass with a wide lookback** before the routine 45-day cron window
   takes over, since the 43-referrer cluster is from July — the default window will never
   see it:
   ```sql
   select public.scan_and_quarantine_dormant_referral_shells(50, 0.05, interval '2 years');
   ```
   Expect roughly 39 referrers newly frozen and ~16,000–17,000 bot accounts soft-deleted
   (exact count depends on how many of the 43 already got swept by something else in the
   meantime — re-check `bot_referral_ring_detections` first).
3. Verify a sample of the 3 excluded referrers (`ae474e60...`, `dd7e88ae...`,
   `5df3fcbc...`) were **not** touched — they should still show `is_frozen = false` and
   their cohorts should still be intact.

## What was deliberately left alone

- The 3 referrers with real `rent_requests` activity under their cohort — treated as
  genuine agents, same reasoning as the `864b1df4...` case in doc 21.
- `landlord_ambassador_referrals`, `merchant_agent_referrals`, and `supporter_referrals` —
  doc 21 already flagged these as unaudited for the same pattern; still true, still not
  checked in this pass.

## What not to do

- Don't lower `p_max_active_ratio` much below 0.05 without checking real agents with a
  handful of dormant referrals first — a genuine agent whose referred cohort includes a
  few people who never activated could otherwise get swept in.
- Don't hard-delete anything here either — same rule as doc 21.

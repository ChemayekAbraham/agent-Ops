# 23 — Automated bot-referral-ring hunter

**Read this before touching `scan_and_quarantine_bot_referral_rings`, its thresholds,
or the `scan-bot-referral-rings` cron job — this function auto-freezes accounts and
auto-deletes rows with no human in the loop. Changing its thresholds carelessly can
either let real fraud through or wrongly quarantine real users.**

## What this is

Everything in `21-referral-bonus-bot-signup-fraud-ring.md` and
`22-signup-entry-points-hardening.md` was **manual**: Josh spotted something, asked
for it to be investigated, and a human-directed cleanup ran once. Per Josh's explicit
request ("we develop our own to look for [bot] accounts and blot them out"), this
turns the exact detection logic validated by hand this session into a standing job
that runs every 30 minutes with no human trigger.

## The detection signal

A referrer whose referred cohort, in the last 48 hours, is **all three** of:

| Condition | Threshold | Why |
|---|---|---|
| `referred_count` | `>= 15` | Below this, could plausibly be a real small referral chain |
| `distinct_names / referred_count` | `< 0.4` | A bot reuses one or two fake names across dozens/hundreds of rows; a real referrer's cohort has mostly distinct names |
| `synthetic_email_count / referred_count` | `< 0.5` | Excludes the legitimate agent-assisted registration paths (`@welile.agent` / `@welile.user` / `@noapp.welile.user`), which are real recruitment, not fraud |

This exact combination was validated against real data on 2026-09-14: it correctly
identified all 24 confirmed fraud referrers from that day's investigation, **and**
correctly cleared the one real high-volume agent checked as a false-positive control
(`864b1df4...`, 1,456 genuine sub-agent signups: 89% distinct names, 99% synthetic
email — excluded by both the name and email thresholds).

## What it does when it finds one

Both actions are reversible; neither touches ledger history — same discipline as the
manual cleanups:

1. **Freezes the referrer** via the existing `fraud_block_user_identifiers()` (skipped
   if already frozen).
2. **Soft-deletes the referred bot cohort** (unconfirmed email, not already deleted)
   using the same redact-and-register pattern as `admin_soft_delete_account()`.
3. **Logs every detection** to `bot_referral_ring_detections` — referrer, counts,
   ratios, action taken, timestamp — regardless of outcome, so this is fully
   auditable after the fact even though no human approved any individual action.

Runs as `cb798acb-68bc-4b4e-a414-a3d374e030b6` (Josh Wanda) for attribution, under his
standing authorization for this specific, narrowly-scoped policy — not because he
personally reviewed each instance.

## Why it's safe to run unattended

- **Scoped to a validated, low-false-positive signal only.** It does not act on the
  broader "high volume + bursty" pool that was measured and deliberately left alone in
  `21` (256 referrers, dominated by real agent activity) — that pool needs individual
  human review, and this job doesn't touch it.
- **Every write is reversible.** `fraud_identity_blocks.status` and `profiles.is_frozen`
  can be released; `admin_restore_soft_deleted_account()` reverses the soft-delete.
  Nothing in `general_ledger` is ever touched.
- **Idempotent.** Re-running finds nothing new for an already-handled referrer (its
  bot cohort's `deleted_at` is already set), so there's no double-action risk from
  running every 30 minutes indefinitely.
- **Financially lower-stakes than before.** Since `get_referral_progress()` now
  requires genuine milestone activity (the `21` root-cause fix), any *new* bot ring
  this job catches was never going to earn a referral bonus in the first place — this
  job is cleanup/platform-hygiene, not loss prevention. The money exposure that made
  the original incident serious is already closed off structurally.

## Relationship to the other guards

This is the third and final layer, in order:

1. **`handle_new_user()` signup-velocity guard** (real-time, at signup): blocks the
   account from ever being created — 5 signups/hour or 10/day from one referral link.
2. **Supabase Auth CAPTCHA** (not yet enabled — see `22`, requires Dashboard access):
   would block a script from creating *any* account at all, referrer or not.
3. **This job** (backstop, every 30 min): catches whatever slips past #1 — e.g.
   several different referrer identities each staying under the per-referrer cap, or
   any gap in #1's coverage found later — and cleans it up automatically instead of
   waiting for the next manual investigation.

## Known limits

- **Does not cover a bot ring with no `referrer_id` at all.** There's no common
  referrer to group by, so this specific detector has nothing to key on. A future
  version would need a different signal (email/phone pattern clustering independent
  of referrer) — not built yet, flagged as a real gap.
- **`>= 15` in 48 hours means a slow, patient ring could stay under the radar longer
  than a fast one.** The `handle_new_user()` velocity guard already blocks anything
  fast; this job's window is tuned to catch what's left, not to be instant.
- **Untested against a live production match at deployment time** (zero rings existed
  when it first ran, by design — the manual cleanup already cleared everything). The
  write path reuses the exact statement shapes already run and verified three times
  by hand earlier the same day, parameterized over an array instead of a literal
  list, but its first *real* trigger should still be watched:

## Verify this is working

```sql
-- Confirm the job is scheduled and active.
select jobid, jobname, schedule, active from cron.job where jobname = 'scan-bot-referral-rings';

-- Check what it's found and done, most recent first.
select * from public.bot_referral_ring_detections order by detected_at desc limit 20;

-- Manually trigger a scan right now instead of waiting for the schedule.
select public.scan_and_quarantine_bot_referral_rings();
```

## What not to do

- Don't lower the thresholds "to catch more" without re-validating against real data
  first — `referred_count >= 15` and `distinct_names/referred_count < 0.4` were
  chosen because they were checked against a real false positive
  (`864b1df4`). Loosening either one without re-checking risks quarantining a real
  agent's real account.
- Don't remove the `synthetic_email_count` exclusion to "simplify" the query — that's
  what separates legitimate agent-assisted recruitment from fraud in this detector.
- Don't extend this job's write path to touch `general_ledger`, wallets, or anything
  with a balance. If a future version needs to claw back money, that needs a human
  decision every time, the way the original 24-referrer incident did — not an
  automated policy.

# 86. Bot-referral-ring hunter rebuilt (v2) — read this before touching signup fraud detection again

**This is the document to read before anyone next touches `scan_and_quarantine_bot_referral_rings`,
its thresholds, or the wider question of "how do we know a signup is real." It exists specifically
so the mistakes in this file are not repeated by a future developer who didn't see them happen.**

## The one-sentence version

The bot hunter built 2026-09-14 (doc 23) ran perfectly, every 30 minutes, without a single missed
tick, for 5 days — and caught nothing, while a 7-month, 4,499-account fraud ring sat in plain sight
the entire time, because every one of its three detection assumptions was individually wrong for
that ring's specific shape. A fourth wrong assumption was found in the *rebuild itself*, live, the
same day. None of the four were exotic — each one is the kind of "this filter obviously means the
account is real" shortcut that's easy to write and hard to notice is wrong until a real bot proves
it.

## What actually happened, in order

1. Doc 85 found 4,838 users with an empty, ≤2-character, repeated-character, digits-only, known-
   placeholder-word, or vowel-less-gibberish `full_name`. Tracing 4,781 of them by `referrer_id`
   isolated 53 referrers behind 4,499 of them, running 2026-02-11 → 2026-09-14 — a real, large,
   multi-month fraud ring, not scattered noise.
2. That ring should have been caught by the standing hunter (doc 23, deployed 2026-09-14, runs
   every 30 minutes). It never was. Doc 85 traced exactly why — three separate, independent blind
   spots, detailed below.
3. Josh asked for the hunter to be rebuilt to close those gaps, erase the confirmed ring, and
   document it so it doesn't happen again. This doc, plus the two migrations it links, is that
   response.
4. While deploying the rebuild, a **fourth** blind spot was introduced and caught live, in
   production, within minutes: an intermediate version of the new function skipped every
   already-frozen referrer entirely, which meant two referrers frozen by earlier *unrelated*
   manual cleanups (`kagwa hassan`, `MUHANGUZI MICHEAL`) would have kept their unpurged bot
   cohorts forever, for the exact same reason the original ring survived — an "already handled,
   so skip it" assumption that wasn't actually true. Fixed and re-verified before this doc was
   written, not after.
5. End state: 13 referrers actioned across two runs, 3,390 accounts soft-deleted, 2 preserved
   because they had real activity, zero `general_ledger` rows touched, a third run confirming
   convergence (0 new detections). Full numbers in
   `20260919170000_rebuild_bot_referral_ring_hunter_v2.sql`'s own "RESULTS" section.

## The four wrong assumptions — read every one before writing a fifth

| # | The assumption | Why it felt reasonable | Why it was wrong | The real ring that broke it |
|---|---|---|---|---|
| 1 | "Scanning the last 48 hours is enough — that's how fast fraud shows up." | Most abuse *is* fast; a tight window keeps the query cheap. | A patient or simply-forgotten ring is invisible forever once it's older than the window, no matter how many times the scan runs. | This ring, 7 months old. Also doc 39's 2026-08-18 burst, found 40+ hours after the fact. |
| 2 | "A frozen referrer is a handled referrer." | Freezing is the terminal action for a confirmed bad actor — what's left to do? | Freezing and *purging the referred cohort* are two different actions. If the purge step has its own bug (see #4 of this table), a referrer can be frozen forever with their bot cohort still fully live, and if detection also skips frozen referrers, nothing ever revisits that mismatch. | `kagwa hassan` and `MUHANGUZI MICHEAL` — frozen by earlier unrelated cleanups, 323 and 96 live bot accounts respectively, never purged, invisible to the intermediate v2 draft for this exact reason. |
| 3 | "A bot ring reuses the same 1-2 fake names — that's the tell." | True for the first ring ever found this way (OKIROR ANDREW: `"morning"` x166, `"morning too"` x61). | A different bot generator can just as easily produce a **unique** random string per account. High name diversity was never evidence of *real* users — only evidence of *how the generator was written*. Testing for reuse alone misses any generator that doesn't reuse. | This ring: 97%+ distinct names, all individually gibberish (`Jsjsjs`, `Fdhgh`, `Hhhhy`, ...). |
| 4 | "A mostly-synthetic-email cohort is legitimate agent-assisted recruitment, not fraud." | True in the one control case checked when doc 23 shipped (a real agent, 1,456 real referrals, 99% synthetic email). | Both real fraud rings found this session are **also** ~100% synthetic email, for the mundane reason that both used the phone-OTP or agent-assisted signup path, which always produces a synthetic placeholder address whether the account is real or not. Email pattern distinguishes *which signup form was used*, not *whether a human is behind it*. | This ring (`@noapp.welile.user`) and OKIROR ANDREW's (`@welile.agent`) both — this condition would have excluded either one even if every other signal had fired correctly. |

**The pattern underneath all four:** every one of them took a proxy that was correlated with
"real" in the one case it was checked against, and quietly promoted it to "proof of real." A proxy
validated against one real ring and one real control is not validated against every future ring —
it's validated against exactly those two data points. The fix in every row of the table above is
the same shape: replace or supplement the proxy with something that measures the actual thing you
care about, even if it costs more to compute.

## What v2 actually checks now

- **No time window** on a referrer's referred cohort — their entire live history is evaluated
  every scan. Made affordable by the fact that a referrer whose bot cohort is fully purged drops
  below the detection threshold on its own (see the migration's own comments for why this needed
  to be structural, not an `is_frozen` shortcut).
- **Two independent content signals**, either of which fires detection: name-reuse (`distinct
  names / referred < 0.4`, the original signal, still valid for reuse-style bots) **or**
  individual name quality (`>= 50%` of names are empty/too-short/repeated-char/digits-
  only/placeholder-word/vowel-less-gibberish, closing the randomized-name blind spot).
- **No email-pattern requirement.** Synthetic-email ratio is still recorded on every detection for
  a human reviewer's context, but no longer gates whether the function acts.
- **Purge eligibility is checked per account, directly against real activity** — zero
  `general_ledger` rows, zero non-zero wallet balance, zero `withdrawal_requests`, zero
  `house_listings`, zero `agent_collections`, and no `rent_requests` that ever left
  `service_center_review`/`cancelled`/`rejected` — instead of the old, wrong `email_confirmed_at
  IS NULL` proxy. An account with real activity is left completely alone even if its referrer gets
  frozen as a confirmed fraud ring.

## What is still, deliberately, not solved

- **A bot ring with no `referrer_id` at all.** Nothing here groups by anything in that case. Real,
  open gap, inherited unchanged from v1.
- **A ring spread across many low-volume referrer identities**, each individually staying under
  the 15-referred threshold. Removing the time window closes the "spread over *time*" evasion; it
  does not close the "spread over many *identities*" evasion, which would need a device/IP
  fingerprint signal this schema doesn't capture at signup.
- **Referral-bonus money already paid to a confirmed fraud referrer.** This function only ever
  freezes and purges; it never touches `general_ledger` or attempts a clawback, because a
  referrer's total earnings usually mix real and fraudulent referrals inseparably at the SQL
  level. That split is always a human FinOps trace (see doc 85, and the still-open OKIROR ANDREW
  case in doc 39) — automating it risks debiting money someone legitimately earned.
- **A referrer whose garbage-name fraction of their TOTAL referred cohort stays under 50%.** A
  referrer with 1,181 total referred and 138 garbage-named (11.7%) reads as a real high-volume
  agent with some messy signups mixed in, not a ring — v2 deliberately leaves this ambiguous case
  alone rather than risk freezing someone real. This is the same "needs individual human review"
  category doc 23 always described; v2 narrows what falls into it, it doesn't eliminate it.

## Before you change a threshold or add a new "obviously fine" shortcut

1. **State which real ring or real control case you're checking the change against**, by name,
   with numbers — not "this seems safer." Every signal in this function exists because a specific
   ring or a specific false-positive control was measured against it (see the Validation table in
   the migration file). A change with no such reference is a guess wearing a threshold's clothes.
2. **Ask what "already handled" actually means for the field you're about to filter on.** `#2`
   above happened because "frozen" was treated as a proxy for "fully cleaned up" without checking
   whether the cleanup step had its own bug. If your filter skips something because you assume an
   earlier step already dealt with it, go verify that assumption against production data first.
3. **Prefer a second, independent signal over tightening an existing one.** `#3`'s fix added a
   name-quality signal instead of trying to make the diversity threshold "smarter" — two orthogonal
   signals, either of which can fire, survive a wider range of bot-generator designs than one
   signal tuned harder ever will.
4. **A proxy for humanness (email pattern, confirmation status, signup channel) is not the same
   thing as humanness.** Check the actual downstream signal you care about — real financial or
   platform activity, in this codebase's case — even when it costs an extra join per account.

## Verify this is still working

```sql
-- Confirm v2's body is live (should be true).
select pg_get_functiondef(oid) like '%hunter v2%' from pg_proc
where proname = 'scan_and_quarantine_bot_referral_rings';

-- What it's caught so far, most recent first.
select referrer_id, referred_count, distinct_names, low_quality_name_count,
       detection_signal, action_taken, bots_soft_deleted, bots_preserved_for_review, detected_at
from public.bot_referral_ring_detections order by detected_at desc limit 20;

-- Manually trigger a scan right now instead of waiting for the schedule.
select public.scan_and_quarantine_bot_referral_rings();

-- Confirm general_ledger has never been touched by this function.
select count(*) from public.general_ledger
where user_id in (select user_id from public.deleted_accounts where reason ilike '%hunter v2%');
-- expect 0
```

## What not to do

- Don't re-add a time window to the cohort scan "to keep it fast" without first checking whether a
  referrer-side exclusion (like the current `is_frozen`-driven self-limiting) can do the same job
  without reintroducing blind spot #1.
- Don't gate detection OR purge on any single proxy field again (email pattern, confirmation
  status, a specific signup source) without checking it against both known real rings in the
  Validation table AND the known real control case — all three, every time.
- Don't assume a referrer's `is_frozen = true` means their referred cohort has actually been
  purged. Check `bots_preserved_for_review` and the live count under that referrer directly; a
  frozen referrer with a large live cohort is exactly the bug this doc exists to prevent.
- Don't attempt an automated referral-bonus clawback from this function or its detections table.
  That decision, every time, belongs to a human with the `referrals` table open next to
  `general_ledger`, not a scheduled job.

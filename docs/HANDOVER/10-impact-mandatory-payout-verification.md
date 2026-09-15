# Impact assessment: "no withdrawal until phone/bank is NID-verified"

> **Update, 2026-09-15:** the "why isn't the backlog draining" question below now has a partial
> answer/mitigation — see
> [`25-borrowed-identity-payout-consent.md`](./25-borrowed-identity-payout-consent.md). A
> self-service SMS-consent path (`payout-destination-consent` edge function) was built to let a
> destination's real owner confirm by SMS code instead of waiting on a Financial Ops phone call,
> exactly the "human-override path, not a hard auto-reject" this document called for. It does not
> add a new block — it adds a second way to drain the existing `waiting` queue. **Not yet live**:
> the migration creating `payout_destination_declarations` has not been run in production.

**Status: assessment only, nothing shipped as a result of this document.** Written
2026-09-14 in response to a proposed policy — block every withdrawal until the user's
payout phone number or bank account is verified by Financial Ops against a National ID,
with the ID name required to match the phone/bank account name. Read this before building
that gate as "block everyone until verified."

## The one-line finding

This is not a feature being proposed from scratch — it's **already partly built and
already stalled**. `profiles.national_id` / `profiles.national_id_name` and a
`payout_destination_verifications` table already exist in production, and that table
already has **3,346 rows stuck in `status = 'waiting'`** with zero visible progress.
Before adding a hard withdrawal block on top of this pipeline, find out why that backlog
isn't moving — a gate on top of a queue that's already not draining just makes today's
Ops backlog block real users' money in real time.

## Numbers, verified live against production 2026-09-13/14

Query tool: `mcp__claude_ai_Lovable__query_database`, project `43e6c2e1-18a6-4503-badb-5bb6c23491cc`.

| Fact | Value | Source |
|---|---|---|
| Users with a withdrawable balance right now | **1,049** | `wallet_totals_cache.active_wallets` (refreshed every 3 min by `refresh-wallet-totals-cache` cron) |
| Total withdrawable balance across those users | UGX 95,879,272 | `wallet_totals_cache.total_withdrawable` |
| Total profiles | 95,345 | `public.profiles` |
| Profiles with `national_id` already on file | 5,174 | `public.profiles` |
| Profiles with `national_id_name` already on file | **0** | `public.profiles` |
| Rows in `payout_destination_verifications` | 3,346, all `status = 'waiting'` | `public.payout_destination_verifications` |

The blast radius for a hard block today is **~1,049 users**, not the whole 95K-profile
base — smaller and more tractable for Ops than "block everyone with an account" sounds.
But every single one of those 1,049 users would be verified for the first time: nobody
has a `national_id_name` on record to match against yet.

## Why an exact name-match rule will misfire

[[feedback_account_name_vs_momo_name_differ]] is a standing, previously-verified finding
in this codebase: **profile name and payout MoMo/bank registration name routinely differ
for legitimate reasons** (agents managing float for someone else, a shared family number,
etc.) and must never be auto-flagged as fraud. A rule that requires the NID name to
literally match the phone/bank account name, enforced strictly and used to gate whether
someone can withdraw their own money, will bounce real, legitimate users at the exact
moment they try to get paid. If this ships, the matching step needs a human-adjudicated
"doesn't match but is fine" path, not a hard reject — otherwise expect a support-ticket
spike and account trust damage, not fraud caught.

There is separately a real DB-level control already shipped for the *different* problem
of "does the withdrawal actually go to the number on file" —
`trg_enforce_withdrawal_payout_account_lock` (commit `2ee0b93d1`, 2026-09-13), which
rejects a Wallet-withdrawal request whose mobile-money number doesn't match the account's
already-registered payout number. That's a narrower, already-safe check and is unrelated
to the NID-name-match idea; don't conflate the two when scoping this.

## What this would do if shipped as "block everyone now"

1. **Immediate liquidity freeze for ~1,049 users** until each is individually phone-verified
   by Ops. On a Rent Plan / Returns platform, "you cannot withdraw your own money" the
   moment this ships is the highest-trust-cost thing this system can do to a real user.
2. **Ops becomes the hard bottleneck**, permanently, not just for the initial backlog.
   "Manually double-verify by phone" doesn't scale as a *standing* gate on every user who
   ever reaches a withdrawable balance — either payouts stall platform-wide waiting on
   Ops capacity, or Ops rubber-stamps to keep the queue moving and the gate stops meaning
   anything.
3. **The existing 3,346-row `waiting` backlog needs an owner and a real cause before
   scope is added on top of it.** Was this table wired up to a UI that never shipped? Is
   there a cron that was supposed to process it and doesn't exist? That's the actual
   constraint on whether "block until verified" is survivable for Ops — not the user
   count.
4. **No new compliance/data-handling surface is created** — `national_id` collection is
   already a live, accepted decision (the columns and table exist) — but it does mean the
   NID-name-matching logic and its false-positive handling are the real remaining design
   work, not "add a column and a check."

## Recommended scoping, if this is picked back up

- Find out what built `payout_destination_verifications` and why it's stalled at 3,346
  `waiting` rows before adding anything on top of it.
- Do not gate retroactively on every existing withdrawable balance in one shot; consider
  scoping to new withdrawals above a threshold, or a grace/appeal path for name mismatches,
  rather than an instant platform-wide freeze.
- Any name-match check needs an Ops override path for legitimate mismatches — see
  [[feedback_account_name_vs_momo_name_differ]] — never a hard auto-reject.
- Re-run the queries in this document before trusting these numbers; `active_wallets` and
  the verification backlog both move continuously.

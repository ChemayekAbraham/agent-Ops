# Partner Return controls — deployment plan (Options A and C)

**Status: prepared for review. Nothing merged, applied, deployed or published.** Each step below needs the CFO's
explicit approval; the merge to `lovable` also needs Josh's go-ahead and a Lovable idle check.

| Option | Branch (local only) | Migration | Rollback |
|---|---|---|---|
| C — Return-cycle guard | `dev/return-cycle-guard` @ `cc4d61b0a4` | `20261024140000_return_cycle_guard.sql` | `supabase/rollbacks/20261024140000_return_cycle_guard.rollback.sql` |
| A — portfolio Return hold | `dev/portfolio-return-hold` | `20261024160000_portfolio_return_hold.sql` | `supabase/rollbacks/20261024160000_portfolio_return_hold.rollback.sql` |

Both migrations check production first and abort without changing anything if a function they replace has changed.
They share no database objects; either order works (combined local test, both orders, 42/42).

## Deployment sequence

0. **Approvals.** CFO approval for each option; Josh's go-ahead; Lovable `get_project` → `agentFinished` and no new
   `lovable-sync-*` branch. Confirm the target remote.
1. **Release branch.** `git fetch origin`; branch `dev/return-controls-release` from `origin/lovable`; merge
   `dev/return-cycle-guard` and `dev/portfolio-return-hold` (merge commits, no rebase). Run `npm run guard:all`
   (two known failures pre-exist on `lovable`: location free-text, persona routes), the type check, the unit suite, the
   guard database suite and both hold suites.
2. **Read-only pre-check on production.** Re-run both preconditions read-only; confirm 0 open Return requests and no
   Return request in `coo_approved` that would become unapprovable.
3. **Apply C** (one transaction), then **immediately** deploy `approve-wallet-operation` and `cfo-direct-credit`.
   Between apply and deploy the old approval's Return postings are refused by the ledger (fail closed: approvals wait).
4. **Publish the frontend** (merge the release branch into `lovable` only now, fast-forward, no force). Open screens from
   before the change are refused on compound/split/principal edit until reloaded (fail closed).
5. **Apply A** (one transaction). Nothing is held yet.
6. **Place holds** with `supabase/ops/portfolio_return_hold_place_eight.sql` (pre-flight, placement, post-check), or
   from the CFO's own session once a CFO hold action exists in the UI.
7. **Watch** for 48 hours: the guard monitoring queries (runbook §8), `select * from portfolio_return_holds`, failed
   approvals, the 21:00 renewal job and the 16:00 top-up merge job logs.
8. **Notify Lovable** after the push so it re-syncs on purpose.

A may also be applied before C (steps 5–6 before 3) if holds are wanted sooner; the order does not change behaviour.

## Rollback procedure

Each rollback is one transaction and touches no money record. Reservation, override and hold tables are kept as records.

- **Remove the holds only (no code change):** CFO approver calls `release_portfolio_return_hold` per portfolio.
- **Roll back A:** run the A rollback file. `merge_paidout_topups` returns exactly to the production body; hold
  triggers and functions are dropped; the holds table stays, unreadable from the browser.
- **Roll back C:** run the C rollback file, then redeploy the previous `approve-wallet-operation` and
  `cfo-direct-credit`, then revert the frontend. `enforce_roi_cycle_once` and the 6-argument
  `post_portfolio_roi_ledger` return to their production bodies; a read-only check stays so a month paid while the
  guard was live cannot be requested again.
- Either rollback may run first; the other option keeps working (tested both ways).

## What the combination blocks that a partner or staff member might legitimately need

| Operation | Who is affected | Behaviour |
|---|---|---|
| Next Return (cash, compound, split) on a held portfolio | partners of the 8 held portfolios | Delayed until release; the cycle is still owed and can be paid after release (not reduced) |
| Top-up into a held portfolio | same partners | Refused before any wallet debit; partner can top up after release |
| Redemption, renewal, lock/unlock, principal split on a held portfolio | same | Refused; renewal job logs and continues |
| Bulk rate / mode / payout-day edit across all of a partner's portfolios (`ActivePartnersDetail`) | staff | Held rows refused, other rows updated — partial result |
| `coo-wallet-to-portfolio` into a held portfolio | staff | Refused at the ledger; leaves one wallet-history log row with no posting (no balance effect) |
| Rent-reward auto-reinvest into a held portfolio | partner with `auto_reinvest` and active rent-facilitation rewards | Payment row marked reinvested with no posting — none of the 8 is exposed (pre-flight checks it) |
| Second Return for the same cycle, compound + cash for the same cycle, double compound (C) | all portfolios | Refused by design; a genuine extra Return needs the CFO override |
| Old open screens editing principal without the new edit token (C) | staff | Refused until reload |
| Wallet withdrawals, refunds of parked top-ups, name / payment-detail edits | — | Not blocked |

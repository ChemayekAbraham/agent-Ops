# Referral bonus logic: audit findings and fix plan

## What the audit found (verified against the live database)

1. **9,751 referrals were never paid.** None of them has a ledger entry. 9,293 are fully eligible today (the invited person has a real profile, the referrer is not frozen, not a self-referral). Backlog is concentrated in Feb 2026 (3,486) and Jul 2026 (5,583). Value at stored amounts: roughly UGX 929,300.
2. **Nothing retries a missed payout.** The bonus is only attempted at the moment the referral row is inserted. The "retry" triggers on houses, rent requests and landlords pass the *acting agent's own* id, so they only re-check referrals where that agent is the invitee — never their invitees. There is no scheduled sweep.
3. **Failures are silent.** The crediting function swallows every error into a warning, so a broken payout leaves no visible trace (this is how the earlier ~698-row silent failure went unnoticed).
4. **Bonuses can only expire, never unlock.** An hourly job flags referral bonuses as expired once their unlock date passes, but the function that marks them as matured (unlocked) is called by no app code and no schedule. Result: 628 referral bonus legs expired, 139 currently locked, and 47,621 of the "matured" ones were matured by a one-off backfill rather than the live path.
5. **Amount drift.** Documented policy says UGX 500; the actual paid amount is the row's restricted amount, which defaults to 100. Historic rows: 27,177 at 300, 15,829 at 500, 13,919 at 100. This plan does not change the amount — that is a money-policy call for you to make separately.

## What will be built

### 1. Recurring payout sweep
A database function that re-attempts every uncredited, eligible referral (invitee profile exists, referrer not frozen, not self-referral, no existing ledger entry for that referral), reusing the existing per-referral idempotency key so nothing can double-pay. Scheduled hourly.

### 2. Backlog backfill
A one-off run of the same sweep over the 9,293 eligible rows, paying each at its stored amount. Batched so it cannot time out, and idempotent — re-running it pays nothing twice.

### 3. Maturity release wired up
A scheduled job that marks referral bonus wallet legs as matured once their unlock date is reached, running *before* the existing expiry sweep in the same hour so a bonus that has legitimately matured is never flagged expired. Plus a one-off pass over the 139 currently-locked legs and a review of the 628 already-expired legs, reported for your decision rather than silently reversed.

### 4. Failure visibility
Replace the silent warning path with a `referral_credit_failures` audit table (referral id, referrer, error text, attempt count, timestamp), written whenever a payout attempt fails. Surfaced as a small panel in the existing admin referrals page so a stuck backlog is visible instead of invisible.

## Technical notes

- New function `public.sweep_uncredited_referrals(p_limit int default 2000)` loops eligible rows and calls the existing `try_credit_qualified_referrals` per invitee; idempotency stays on `referral_signup:<referral_id>`.
- Fix `trg_referral_activation` / `trg_referral_progress_check` so they resolve the acting user's *invitees* rather than passing the actor as `p_referred_id`.
- New cron entries: `sweep-uncredited-referrals` (hourly, minute 5) and `mature-referral-bonuses` (hourly, minute 10) — the existing `expire-stale-bonus-restrictions` runs at minute 15, so maturity always lands first.
- `mature_referral_bonuses_for_invitee` stays as-is; the new scheduled wrapper matures by ledger leg (`category = 'referral_bonus'`, `ledger_scope = 'wallet'`, `now() >= withdrawable_after`) rather than per invitee.
- `referral_credit_failures`: RLS on, service_role full access, read access for admin/manager roles via `has_role`, plus the required GRANTs.
- No wallet balances are written directly — all payouts go through `create_ledger_transaction` exactly as today.
- Amount policy (100 vs 300 vs 500) is left untouched; the backfill uses each row's stored amount.

## Out of scope

- Changing the bonus amount or its default.
- Reversing or re-paying the 628 already-expired legs (reported first, actioned on your call).

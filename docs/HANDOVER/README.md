# Welile — Engineer Survival Manual

**Purpose of this folder.** `SYSTEM_CONTEXT.md` explains *how the system works*. This folder
explains *how to not destroy it*. It is written for an engineer who has never met the person who
built it, arriving on a bad day, with production already misbehaving.

**Verified against the live database on 2026-09-09.** Every count and every object name in this
folder was read from the production Postgres catalog on that date, not copied from a migration
file or from `SYSTEM_CONTEXT.md`. See [`06-live-state-verification.md`](./06-live-state-verification.md)
for the exact SQL to regenerate all of it, and re-run it before trusting anything here.

---

## The first 60 minutes

If you have just been handed this system and something is wrong, do these in order.

| # | Step | Where |
|---|---|---|
| 1 | **Do not deploy anything.** Not a migration, not an edge function, not the frontend. Read first. | — |
| 2 | Check the kill switches. Somebody may have already paused the platform, or a switch may be wrongly set. | [`02-danger-zones.md` §Kill switches](./02-danger-zones.md#kill-switches--treasury_controls) |
| 3 | Check whether money is still balanced. One query tells you if the ledger is sound. | [`03-money-invariants.md` §Is the ledger healthy right now](./03-money-invariants.md#is-the-ledger-healthy-right-now) |
| 4 | Find your symptom in the runbooks. Each one says what to check and, more importantly, what *not* to do. | [`04-incident-runbooks.md`](./04-incident-runbooks.md) |
| 5 | If you are locked out of an account or vendor, work the access map. | [`01-ownership-and-access.md`](./01-ownership-and-access.md) |
| 6 | If infrastructure is actually gone, work the rebuild order. | [`05-disaster-recovery.md`](./05-disaster-recovery.md) |

**The one rule that matters most:** this platform holds real money belonging to real Ugandan
tenants, agents and Supporters. `general_ledger` is the record of it. It is append-only by design.
You can always fix a wrong balance by posting a new balanced correction. You can never fix a
deleted ledger row. **Never delete, never `UPDATE`, never "clean up" financial history.**

---

## Contents

| Doc | Read it when |
|---|---|
| [`architecture-map.html`](./architecture-map.html) | **Interactive visual map** of platform topology, double-entry invariants, kill switches, runbooks, and recovery sequence. Open directly in any browser. |
| [`01-ownership-and-access.md`](./01-ownership-and-access.md) | You need to get into an account, or you are auditing who holds the keys. **Contains gaps only the founder can fill — fill them.** |
| [`02-danger-zones.md`](./02-danger-zones.md) | Before you run anything that writes. The catalogue of operations that lose money or data. |
| [`03-money-invariants.md`](./03-money-invariants.md) | Before you touch the ledger, wallets, or any balance. The financial contract, with the real source. |
| [`04-incident-runbooks.md`](./04-incident-runbooks.md) | Something is broken and you need a procedure. |
| [`05-disaster-recovery.md`](./05-disaster-recovery.md) | Infrastructure is lost and you are rebuilding. |
| [`06-live-state-verification.md`](./06-live-state-verification.md) | You do not trust this documentation (correct instinct). Regenerates every fact from the live catalog. |
| [`07-tribal-knowledge.md`](./07-tribal-knowledge.md) | The traps that have already cost real money. Read this once, cover to cover, early. |
| [`08-incident-2026-09-12-merchant-claim.md`](./08-incident-2026-09-12-merchant-claim.md) | A merchant says their claim failed, vanished, or "was taken by another agent". The worked incident: why a retry destroyed the claimer's own reservation, what was rebuilt, and what is **still** broken (the 45-minute stale release). |
| [`09-incident-2026-09-12-landlord-payout-otp-lock.md`](./09-incident-2026-09-12-landlord-payout-otp-lock.md) | An agent says paying a landlord shows "network issue" then locks for 10 minutes. Why a slow SMS-delivery check got mistaken for a dead request, why a client-only lock made it worse, and **why the fix is currently reverted** — read the "Is the fix still live" section before assuming it's deployed. |
| [`10-impact-mandatory-payout-verification.md`](./10-impact-mandatory-payout-verification.md) | Before building "block every withdrawal until NID-verified." The feature is already half-built and already stalled at a 3,346-row backlog; real blast radius is ~1,049 users, but zero of them have a name-match record yet, and an exact-name-match rule will misfire on legitimate accounts. |
| [`11-merchant-telecom-charge-atomicity-fix.md`](./11-merchant-telecom-charge-atomicity-fix.md) | A merchant payout's float debit is missing its telecom fee, or before touching `ensure_merchant_payout_float_debit`, `classify_merchant_payout_funding`, or `sweep_merchant_payout_float_debits`. Why every merchant payout silently lost its telecom leg, why a shared idempotency gate permanently blocked backfilling it, and the cutoff-timestamp bug that shipped alongside the fix. |
| [`12-withdrawal-payout-account-lock.md`](./12-withdrawal-payout-account-lock.md) | A user disputes a wallet withdrawal paid to an unrecognized number, or before touching `enforce_withdrawal_payout_account_lock` or `submit_withdrawal_request`. Why the "locked number" promise was UI-only, the DB-level fix, and why a blocked attempt was briefly forensically invisible even after a first fix attempt. |
| [`13-ip-actor-audit-instrumentation.md`](./13-ip-actor-audit-instrumentation.md) | You need to know whether a sensitive action captures IP/actor identity, before adding a new capture trigger, before trusting `request.headers` for anything, or when `security_ip_audit_alerts` flags something. The full initiative: 49 implementation items, the edge-runtime IP-spoofing correction, client-supplied agreement IPs, the landlord MoMo actor-attribution root cause, the missing-IP watchdog, and the adversarial regression findings — plus what's still open. |

---

## Known documentation drift — read before trusting `SYSTEM_CONTEXT.md`

`SYSTEM_CONTEXT.md` is a good architecture reference but it has measurably fallen behind
production. Measured 2026-09-09:

| Fact | `SYSTEM_CONTEXT.md` says | Production actually has |
|---|---|---|
| Public tables | 423 | **641** |
| Public functions | 1002 | **1907** |
| Non-internal triggers | 382 | **601** |
| RLS policies | 1141 | **1552** |
| Views / matviews | 22 / 3 | **71 / 6** |
| Enums | 25 | **33** |
| `pg_cron` jobs | 98 (5 inactive) | **151 (9 inactive)** |
| Storage buckets | 21 | **27** |
| Edge functions | 279 | **342** directories in repo |

Two behavioural drifts matter more than the counts:

1. **`get_user_available_balance` no longer reads `v_user_wallet_strict`.** It reads the
   `wallet_balances_projection` table and subtracts `funder_pending_hold()`, plus advance-locked
   withdrawable when the `advance_withdrawals_paused` switch is on. `SYSTEM_CONTEXT.md` §5.3 is
   out of date. The live definition is quoted in [`03-money-invariants.md`](./03-money-invariants.md).
2. **`sweep-agent-advance-recovery` is not a 15-minute job.** It runs once daily at `50 16 * * *`
   UTC. `process-agent-advance-deductions` runs every 6 hours, not daily at 18:00 EAT.
   `SYSTEM_CONTEXT.md` §6.1 and §10 are out of date.

Also note `README.md` claims `guard:all` runs `guard-mcp-deploy.mjs` and `guard-persona-routes.mjs`.
It does not — see `scripts/run-guards.mjs` for the real list of seven guards.

Treat the code and the database catalog as authoritative, always. When you find drift, fix the
document in the same change.

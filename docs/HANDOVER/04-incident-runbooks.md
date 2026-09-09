# 4. Incident Runbooks

Symptom-driven. Each runbook says what to check, what to do, and — the part that matters most —
what **not** to do.

**Before any of them:** read `treasury_controls` (see
[`02-danger-zones.md`](./02-danger-zones.md#kill-switches--treasury_controls)). A platform that
looks broken may simply be paused.

**If money is moving wrongly and you do not yet know why:** set
`maintenance_mode.enabled = true` first. Stopping the bleeding beats diagnosing while it bleeds.

---

## A. Nobody can log in

**Almost always SMS/OTP, not auth.** Yoola is the primary channel; Africa's Talking and LANA are
fallbacks.

Check:

```sql
SELECT status, count(*) FROM public.sms_delivery_log
WHERE created_at > now() - interval '2 hours' GROUP BY 1 ORDER BY 2 DESC;

SELECT * FROM public.sms_message_exceptions ORDER BY created_at DESC LIMIT 20;
```

Then:

1. Is `YOOLA_SMS_API_KEY` valid? An expired key fails every OTP.
2. Has a **sender ID** been set anywhere? Forcing `WELILE` makes carriers drop messages silently
   — it is unregistered. Omit the field so Yoola uses its registered default.
3. Is the fallback chain reaching Africa's Talking? `AFRICASTALKING_API_KEY` +
   `AFRICASTALKING_USERNAME`.
4. `detect-sms-verification-failures` runs every 15 minutes; `sms-failure-daily-alert` at 06:00 UTC.

Alternative ways in while SMS is down: email+password, Google OAuth, WhatsApp magic link
(`whatsapp-login-link`), staff access codes at `/staff-portal`.

**Do not** rotate the Yoola and Africa's Talking keys in the same window. If both are wrong at
once, nobody can receive an OTP — including you.

---

## B. Deposits are not being credited

The chain is: MoMo receipt email → Gmail poll → `gmail_transactions` → match →
`deposit_requests` → `approve-deposit` → ledger.

Check each link:

```sql
-- 1. Is the poll still ingesting? Runs every 2 minutes.
SELECT max(created_at) AS last_ingest, count(*) AS last_hour
FROM public.gmail_transactions WHERE created_at > now() - interval '1 hour';

-- 2. What is stuck, and for how long?
SELECT status, count(*), min(created_at) AS oldest
FROM public.deposit_requests
WHERE created_at > now() - interval '7 days' GROUP BY 1;

-- 3. The detectors
SELECT * FROM public.deposit_match_alerts      ORDER BY created_at DESC LIMIT 30;
SELECT * FROM public.deposit_bridge_gap_alerts ORDER BY created_at DESC LIMIT 30;
```

Common causes, in order of likelihood:

1. **`GOOGLE_MAIL_API_KEY` expired or the mailbox changed.** Ingestion stops dead; nothing else
   looks wrong. Check `last_ingest` first.
2. **Name-only till receipts.** MTN till receipts carry a payer name and no TID. Exact-match-or-
   nothing silently orphaned these. A fuzzy-flag fix was built on 2026-08-28 — **verify the
   migration is actually deployed** before assuming it is in force.
3. **Cross-user TID collision.** `trg_enforce_tid_deposit_uniqueness` blocks TID reuse; a genuine
   collision between two users needs manual routing.
4. **Cash-code deposits are never auto-credited by design.** The user must enter the `RCT` code
   via `cash-deposit-verify-code`. This is not a bug.

Relevant jobs: `gmail-poll-transactions` (2 min), `email-auto-match-retry-24h` and
`email-auto-create-deposits-24h` (2 min), `deposit-bridge-worker-30s` (30 s),
`relink-stuck-pending-deposits-daily` (03:30), `auto-reject-unmatched-deposits` (15 min).

**Do not** hand-credit a wallet to "fix" a stuck deposit. Route it through `approve-deposit` so
the double entry and the deposit record stay consistent.

**Verify against ingested data, not a screenshot.** A payer-side SMS screenshot is not the
merchant-side row that was actually ingested. Check `gmail_transactions` before diagnosing.

---

## C. A wallet balance is wrong

First decide which direction:

- **Phantom drift** — cache above ledger. The user can withdraw money that is not there.
- **Hidden owed** — cache below ledger. The user is owed money they cannot see.

```sql
SELECT * FROM public.phantom_wallet_drift WHERE user_id = '<uuid>' ORDER BY created_at DESC;
SELECT * FROM public.wallet_anchored_balance_drift_view WHERE user_id = '<uuid>';
SELECT public.get_user_available_balance('<uuid>');
SELECT * FROM public.wallet_balances_projection WHERE user_id = '<uuid>';
SELECT * FROM public.wallets WHERE user_id = '<uuid>';
```

Escalating repairs — try in this order, stop when it agrees with the ledger:

| Step | Call | Notes |
|---|---|---|
| 1 | `rebuild_wallet_projection(p_user_id)` | Rebuilds the table `get_user_available_balance` reads |
| 2 | `reconcile_wallet_from_ledger(p_user_id, p_reason)` | **The safe default.** Derives from the ledger |
| 3 | `reseed_anchored_withdrawable(p_user_id, p_reason)` | Phantom (cache too high) |
| 4 | `reseed_anchored_balance(p_user_id, p_reason)` | Under-cache |
| 5 | CFO balanced correction | Only when the *ledger itself* is wrong — see [`03`](./03-money-invariants.md#how-to-correct-a-wrong-balance--the-only-sanctioned-procedure) |

**Do not** call `admin_reseed_wallet_cache(user, withdrawable, balance)` to make a number look
right. It writes absolute figures into the cache and hides the real defect.

Automatic repair jobs already running: `repair-wallet-cache-drift-15m`,
`refresh-wallet-totals-cache` (3 min), `wallet-projection-drift` (15 min),
`nightly-wallet-ledger-reconciliation` (02:15). Give them a cycle before intervening by hand.

---

## D. Withdrawals are stuck

Path: request → hold → dispatch to merchants → merchant claims → merchant pays from own MoMo →
proof uploaded → `approve-withdrawal` → ledger + receipt.

```sql
SELECT status, count(*), min(created_at) AS oldest
FROM public.withdrawal_requests
WHERE created_at > now() - interval '7 days' GROUP BY 1;

SELECT enabled FROM public.treasury_controls WHERE control_key IN
  ('withdrawals_paused','payouts_ui_enabled','advance_withdrawals_paused');
```

Check in order:

1. `withdrawals_paused` — is it on?
2. `payouts_ui_enabled` — off blocks withdrawals server-side via
   `enforce_payouts_ui_flag_on_withdrawals`.
3. Merchant liquidity. No merchant with float means nothing gets claimed.
   `notify-merchants-new-withdrawal`, `redispatch-withdrawals` (every minute),
   `release-stale-claims`.
4. `detect-stale-withdrawal-holds` (every 6 h) and `monitor-bulk-payout-stuck` (15 min).

**Do not** approve a withdrawal outside `approve-withdrawal`.
`enforce_withdrawal_ledger_match` exists because mismatched postings have happened before.

---

## E. A ledger group does not balance

**This is the emergency case.** `trg_enforce_ledger_group_balance` should make it impossible.

1. Set `maintenance_mode.enabled = true`.
2. Run the health query in [`03-money-invariants.md`](./03-money-invariants.md#is-the-ledger-healthy-right-now).
   The number that must be zero is **unbalanced multi-leg groups in the last 30 days**.
3. If it is non-zero, find the posting path — some code is inserting without the RPC, or a
   trigger has been disabled.

```sql
SELECT tgname, tgenabled FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
WHERE c.relname = 'general_ledger' AND NOT t.tgisinternal
ORDER BY tgname;   -- tgenabled must be 'O' for all 38
```

**Do not** delete or edit rows to make the sum come out. Post a balanced correcting entry.

Single-leg groups on their own are **not** this emergency — see the interpretation notes in
[`03`](./03-money-invariants.md#how-to-read-that-result).

---

## F. A scheduled job stopped running

151 `pg_cron` jobs, 142 active.

```sql
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = '<name>';

SELECT status, start_time, end_time, left(return_message, 300) AS msg
FROM cron.job_run_details
WHERE jobid = <jobid> ORDER BY start_time DESC LIMIT 20;
```

Note `prune-cron-job-run-details` runs daily at 02:15 — **run history is short.** Investigate
promptly or the evidence is gone.

Nine jobs are deliberately inactive: `refresh-daily-stats`, `cleanup-old-system-events`,
`refresh-financial-summaries-daily`, `check-agent-liquidity-hourly`, `process-debt-recovery-daily`,
`process-promissory-deductions-daily`, `partner-ops-automation-daily`, `vacancy-alerts-daily`,
`daily-recalculate-credit-limits`. Do not switch one on without understanding why it was stopped
— several move money.

Cron rows embed the project URL and an apikey, so they are created with the insert tool, **not**
in a migration.

---

## G. The build or publish fails

```bash
npm run guard:all       # runs the seven pre-build guards; the failing one is named explicitly
npm run lint
```

`scripts/run-guards.mjs` prints a single unambiguous block naming the guard, its command, exit
code and full output. "Publishing failed because of an error in your app" almost always traces to
one guard.

`verify-dist.mjs` runs after the build and checks the output is sane.

**Do not run a bare `tsc` on this repo.** It OOMs at 4 GB and is OS-killed at 8 GB. A crashed
`tsc` reports **zero errors**, and piping it through `head` hides exit 134 behind the wrapper's 0.
You will believe the typecheck passed when it never ran. Use `npm run build`, which uses
`run-with-heap.mjs`.

**Do not disable a guard to get a build out.** Each one encodes an incident that already happened.

---

## H. Merchant float looks wrong

Merchants front their own MoMo cash to settle user withdrawals and are reimbursed principal plus
0.5% commission.

```sql
SELECT * FROM public.merchant_float_variances ORDER BY detected_at DESC LIMIT 30;
SELECT enabled, value FROM public.treasury_controls
WHERE control_key IN ('merchant_float_anchor_date','merchant_out_of_pocket_headroom');
```

Two rules that have already cost money:

1. **Never assert an absolute float figure.** "Set float to X" re-credits float that has already
   been spent. Use a delta. Sky Bubbles was over-credited UGX 10,202,000 this way on 2026-08-25,
   still uncorrected.
2. **The telecom charge is part of the float debit, not a separate receivable.** A UGX 5,000
   payout with a UGX 500 fee debits UGX 5,500 as **one atomic transaction**. Splitting them
   created phantom telecom receivables in the past.

Jobs: `detect-merchant-float-variances` (30 min), `reconcile-merchant-payout-funding` (10 min),
`reconcile-merchant-payout-commissions` (15 min), `release-stale-merchant-float` (hourly),
`merchant-float-morning-report` (04:00 UTC).

---

## I. Duplicate Returns credit to a Supporter

`process-supporter-roi` runs daily at 06:00 UTC. `auto_roi` is currently **`false`**.

Returns are idempotent **per cycle**. A duplicate means the idempotency key was missing or
differed between runs.

```sql
SELECT portfolio_id, cycle_month, count(*)
FROM public.supporter_roi_payments
GROUP BY 1,2 HAVING count(*) > 1;
```

Fix by posting a reversing balanced entry, or `void_ledger_entry(p_ledger_id, p_reason)`. Then fix
the idempotency key so it cannot recur. `enforce_roi_cycle_once` is the trigger-level guard.

**Do not** delete the duplicate `supporter_roi_payments` row and leave the ledger legs behind.

---

## J. A landlord payout is stuck

Payouts require landlord-phone OTP: `issue-landlord-payout-otp` → `verify-landlord-payout-otp` →
`landlord-payout-disburse`.

```sql
SELECT * FROM public.landlord_payout_otp_challenges
WHERE landlord_id = '<uuid>' ORDER BY created_at DESC LIMIT 10;

SELECT enabled FROM public.treasury_controls WHERE control_key = 'landlord_payout_priority';
```

Usual cause is the OTP never arriving — that is really runbook A. `enforce_single_live_landlord_payout`
prevents concurrent payouts to the same landlord, which can also look like "stuck".

---

## K. An agent cannot create a rent request

Almost always the **daily eligibility gate**, working as designed:
`tr_enforce_agent_daily_eligibility` blocks a new request when an agent with active tenants has
collected less than 20% of `expected_daily` (best of today/yesterday, Africa/Kampala day buckets,
sourced strictly from `agent_collections`).

```sql
SELECT * FROM public.get_agent_daily_eligibility('<agent_uuid>');
SELECT * FROM public.v_agent_daily_eligibility WHERE agent_id = '<agent_uuid>';
```

Other gates that raise: landlord not registered, missing tenant photo, missing GPS, duplicate
request, agent capacity, `DAILY_ELIGIBILITY_BLOCKED`.

If the agent is frozen they see the full-screen `AgentFrozenGate` banner — check
`fraud_identity_blocks`. Unblocks are audited in `agent_eligibility_unblock_events`.

**Do not** bypass the gate for one agent. It is the platform's main collections-discipline control.

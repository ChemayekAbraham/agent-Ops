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

**If the above says the cache agrees with the ledger and the balance is still "wrong," the ledger
itself may have double-charged the user** — this is not drift, and steps 1-4 above will not fix
it. Read `general_ledger` chronologically for the user (wallet-scope legs only) instead of
trusting any single cached figure:

```sql
SELECT transaction_date, amount, direction, category, description, source_table, source_id
FROM public.general_ledger
WHERE user_id = '<uuid>' AND ledger_scope = 'wallet'
ORDER BY transaction_date ASC;
```

Sum it by hand. If the same real-world payout (same amount, same rough date) produced **two**
`cash_out` legs — one usually a generic manual correction with `source_table` unrelated to what
it was actually fixing — that is a duplicate debit, not drift. Fix with a step-5 CFO balanced
correction (credit back the duplicated amount), not a cache reseed.

**Worked example:** Fredrick Baliddawa, 2026-09-11 — wallet showed UGX 5,200,000 right after a
fresh UGX 7,000,000 credit. A prior UGX 1,800,000 withdrawal had been debited twice: once by a
manual CFO correction with no link back to the withdrawal, and again months later by the
stale-withdrawal-hold sweep, which had no way to see the first one. See
[`07-tribal-knowledge.md` §7](./07-tribal-knowledge.md#7-a-stale-withdrawal-reconciliation-job-can-double-debit-a-wallet-a-manual-correction-already-fixed)
for the root cause and the fix applied to `cfo_reconcile_stale_withdrawal`.

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
   `release-stale-cashout-claims` (every 5 minutes).
4. `detect-stale-withdrawal-holds` (every 6 h) and `monitor-bulk-payout-stuck` (15 min).
5. **If merchants say they cannot claim** — the claim succeeds but "disappears", or they are told
   another agent took it — that is a different failure. Read
   [`08-incident-2026-09-12-merchant-claim.md`](./08-incident-2026-09-12-merchant-claim.md) and
   query `withdrawal_claim_attempts`, which records every attempt with a result code.

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

---

## L. An agent's commission stops even though their advance shows "completed"

Real incident, 2026-09-11: agent Okwakol Micheal's `agent_advances` rows both showed
`status='completed'`, `outstanding_balance=0` — yet his rent-collection commission had dropped
and he could not withdraw anything. Two independent causes were stacked. Check both.

**1. A bogus `agent_subagents` parent is skimming 2% off every collection.**

`agent_allocate_tenant_payment_internal` (agent-float rent collections) checks whether the
collecting agent is a **verified sub-agent of someone else**. If so, and they are not in
`agent_subagent_commission_whitelist`, it pays 8% instead of 10% and routes the other 2% to
`parent_agent_id` as a "recruiter override."

```sql
SELECT id, parent_agent_id, sub_agent_id, status, source, created_at
FROM public.agent_subagents WHERE sub_agent_id = '<agent_uuid>';
```

If `parent_agent_id` resolves to someone who isn't a real recruiting agent (check `profiles` —
Okwakol's was one of his own tenants), the row is bad. Void it:

```sql
UPDATE public.agent_subagents
SET status = 'rejected', rejection_reason = '<why>'
WHERE id = '<row_id>';
```

**This can be wider than one agent.** The bad `parent_agent_id` in this incident was reused
across 392 other `agent_subagents` rows via `source='admin_assignment'`. Before closing the
ticket, check whether the same `parent_agent_id` appears elsewhere:

```sql
SELECT status, source, count(*) FROM public.agent_subagents
WHERE parent_agent_id = '<the bad parent id>' GROUP BY 1, 2 ORDER BY 3 DESC;
```

**2. Their real `withdrawable` balance is negative and clamped to 0 on screen.**

`agent_advances.status` tracks the *loan*. The wallet-side `agent_repayment` recovery is a
separate running total that can lag behind it. A negative `withdrawable` bucket clamps to 0 in
`wallet_strict_for_user`, `wallet_balances_projection`, and the dashboard — so the agent sees
"0", never "owed 229,580". Check the raw, unclamped sum:

```sql
SELECT sum(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END) AS raw_withdrawable
FROM public.general_ledger
WHERE user_id = '<agent_uuid>' AND ledger_scope = 'wallet' AND wallet_bucket = 'withdrawable'
  AND (classification IS NULL OR classification = 'production');
```

If it's negative, that's the real story, not the advance-status column.

**How to correct both, once approved:**

- Reversing an erroneous credit (clawing back from whoever wrongly received it): post it as
  `classification='admin_correction'`, `category='system_balance_correction'`,
  `direction='cash_out'` — this is the *only* admin-correction shape `wallet_strict_for_user`
  actually counts.
- Making the wronged agent whole: **do not** use `classification='admin_correction'` on the
  credit leg — a `cash_in` tagged `admin_correction` is silently excluded from every balance
  calculation, for any category. It will insert without error and change nothing. Use
  `classification='production'`, category `agent_commission_earned`, explicit
  `wallet_bucket='withdrawable'`, balanced against an `agent_commission_payable` /
  `ledger_scope='platform'` leg on the same user — the same double-entry shape every other
  commission payout already uses.
- Both legs go through `create_ledger_transaction`, never a raw `INSERT` —
  `trg_enforce_ledger_rpc_only` blocks anything else.

See [`07-tribal-knowledge.md` §6](./07-tribal-knowledge.md#6-a-bad-agent_subagents-row-can-silently-skim-an-agents-commission--and-hundreds-of-agents-can-share-the-same-bad-row)
for the full incident writeup, including the specific IDs and the corrected ledger group ids.

**Do not** assume "advance completed" means the agent's commission path is clean. The two are
tracked independently and can drift apart.

---

## M. The Merchant Payout Queue looks empty for every agent

**Check RLS before the permission matrix.** If `cashout_agents.config` (channels/categories/
banks) checks out correct for the complaining agent — or for *several differently-configured*
agents at once — the config is probably not the problem.

```sql
SELECT policyname, cmd, qual FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'withdrawal_requests' ORDER BY cmd, policyname;
```

The `SELECT` policy must allow an active cash-out agent to see rows where
`assigned_cashout_agent_id IS NULL` (unclaimed and up for grabs), not just rows already tied to
them (`assigned_cashout_agent_id` / `dispatch_claimed_by` / `processed_by` = themselves). Without
that clause, Postgres returns zero rows before any client-side channel/category filter runs —
this looks identical to a genuinely empty queue and to a correctly-locked-down agent, so it is
easy to chase the wrong fix for a long time.

**Any tool that queries with a privileged/service role (including `query_database`-style admin
tooling) bypasses RLS entirely** — "the data and config are correct" checked that way tells you
nothing about what the agent's own session can actually see. Always cross-check the policy set,
not just the row data.

Fixed 2026-09-11 — see migration `20260911150000_allow_cashout_agents_view_unclaimed_withdrawals.sql`
and [`07-tribal-knowledge.md` §19](./07-tribal-knowledge.md#19-an-rls-policy-not-the-permission-matrix-can-make-the-merchant-payout-queue-empty-for-everyone)
for the full incident, including two related bugs it surfaced in the proof-of-payment blocker and
a still-open gap where `claim_withdrawal_verified` doesn't enforce the permission matrix
server-side.

**Do not** run `ALTER POLICY` against this table without expecting `40P01 deadlock detected`
under live traffic — it's transient lock contention from concurrent reads, not a bad statement.
Retry it.

---

## N. One merchant is holding multiple claims / claimed withdrawals never come back to the queue

Three causes. Two were addressed 2026-09-11; the third — and worst — survived until 2026-09-12,
and one half of the second is **still open**. Full worked incident:
[`08-incident-2026-09-12-merchant-claim.md`](./08-incident-2026-09-12-merchant-claim.md).

**Fastest diagnostic now:** `withdrawal_claim_attempts` records every claim attempt with a result
code (`CLAIM_SUCCESS`, `CLAIM_ALREADY_OWNED_BY_SELF`, `CLAIM_ALREADY_OWNED_BY_OTHER`,
`CLAIM_BLOCKED_ACTIVE_CLAIM`, `CLAIM_RESERVATION_FAILED`, …). Read it before asking the merchant
what they saw.

```sql
SELECT a.created_at, p.full_name, a.result_code, a.error_code, a.idempotent,
       a.race_lost, a.reservation_outcome, a.blocking_withdrawal_id
FROM public.withdrawal_claim_attempts a
LEFT JOIN public.profiles p ON p.id = a.agent_user_id
ORDER BY a.created_at DESC LIMIT 50;
```


```sql
-- Is a merchant sitting on more than one open claim right now?
SELECT assigned_cashout_agent_id, count(*)
FROM public.withdrawal_requests
WHERE assigned_cashout_agent_id IS NOT NULL
  AND status IN ('pending','requested','manager_approved','cfo_approved','approved','fin_ops_approved')
  AND processed_at IS NULL AND coalesce(fin_ops_reference,'') = ''
GROUP BY 1 HAVING count(*) > 1;

-- Is the stale-claim releaser actually scheduled?
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'release-stale-cashout-claims';
```

1. **One active claim per merchant** is enforced server-side (advisory lock + blocking-claim lookup)
   as of `drizzle/migrations/0006_merchant_one_active_claim_and_stale_release_cron.sql` and its twin
   `supabase/migrations/20260911163000_...`. If the first query above returns rows, the migration
   either wasn't applied or was reverted — check the live function definition, don't assume the file
   being present means it's live.
2. **The claim transaction was rebuilt on 2026-09-12**
   (`supabase/migrations/20260912010000_canonical_merchant_claim.sql`). It now locks the withdrawal
   row *before* touching money, treats a merchant re-claiming their **own** withdrawal as idempotent
   success, and never lets a loser's attempt release the winner's reservation. Before that, a
   merchant's own retry released their own float and answered "already claimed by another agent" —
   every one of the 23 `claim_race_lost` rows in the preceding 24 hours was a self-retry, not a race.
   Confirm it is live:
   ```sql
   SELECT position('CLAIM_ALREADY_OWNED_BY_SELF' in pg_get_functiondef(
     'public.claim_withdrawal_verified(uuid,text,text)'::regprocedure)) > 0 AS canonical_claim_live;
   ```
3. `release_stale_cashout_claims()` only clears claims with **zero settlement progress** (no
   proof/code/TID/processing marker) — that part is by design, so don't expect it to touch an
   in-flight payout. If the cron job is missing/inactive, re-run the migration; it's idempotent.
   **Still open (2026-09-12):** when it does release a claim it does **not** release the merchant's
   float reservation and does **not** notify them — the payout simply vanishes from their screen and
   their float stays locked until the 48-hour sweep. It took Emma Maiso's UGX 95,000 at 01:40 EAT and
   left UGX 27,000 of her float held. The repair exists as
   `supabase/migrations/20260911210000_stale_claim_release_frees_float_reservation.sql` and is **not
   applied**. Check before assuming otherwise:
   ```sql
   SELECT position('release_merchant_float' in pg_get_functiondef(
     'public.release_stale_cashout_claims()'::regprocedure)) > 0 AS stale_release_frees_float;
   ```
4. **A leftover reservation no longer follows the wrong merchant.** Claiming a row that still carries
   another desk's stale reservation now releases it and reserves afresh for the claimant (attempt log
   shows `orphan_released_then_reserved`). Previously the new claimer inherited it and the payout was
   booked as the *other* merchant's own cash — the source of ~UGX 21.3M of misattributed receivables
   in August.

See [`08-incident-2026-09-12-merchant-claim.md`](./08-incident-2026-09-12-merchant-claim.md) for the
full worked incident, and
[`07-tribal-knowledge.md` §20](./07-tribal-knowledge.md#20-the-one-claim-per-merchant-rule-only-existed-in-react-and-the-stale-claim-releaser-had-no-cron)
for the earlier one.

**Do not** manually force-release an agent's claim that's inside its normal in-flight window
(check `dispatched_at` — recent claims are very likely legitimately being worked). Forcing a
release on a claim that's actually mid-payout risks a double payout when the original claimant's
confirmation lands after someone else has already been assigned the same withdrawal.

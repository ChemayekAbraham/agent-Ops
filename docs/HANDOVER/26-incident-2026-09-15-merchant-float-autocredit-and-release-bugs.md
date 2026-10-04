# 26. Merchant float: release-to-queue float leak, auto-credit gaps, and a false-alarm sweep (2026-09-15)

**Severity:** P2 (real money left uncredited on real desks; one P1-adjacent item — a
frontend button calling a nonexistent RPC — caught mid-incident).
**Read this before touching:** `release_withdrawal_claim`, `sweepLinkedPendingDeposits`,
`tryAutoDebitPayout`, `cashout_agents`, `merchant_float_reconciliations`, or the
`gmail-poll-transactions` cron schedule.

---

## What triggered this

A user report: "release back to queue when the merchant agent claims a withdrawal is not
working," followed by "on Financial Ops when money was sent to each merchant agent's phone
number, it was not auto credited as float on their desks." Both were real, and investigating
the second uncovered a third, unrelated bug in the alerting around it.

---

## 1. Manual "Release back to queue" leaked float reservations

Already documented as "Still broken #2" in
[`08-incident-2026-09-12-merchant-claim.md`](./08-incident-2026-09-12-merchant-claim.md):
`WithdrawalPayoutCard.tsx`'s `handleReject()` did a raw
`UPDATE withdrawal_requests SET assigned_cashout_agent_id = NULL, ...` from the browser. It
cleared the assignment but never released the merchant's `merchant_float_reservations` row —
the same defect class already fixed for the 45-minute auto-release cron
(`20260914230000`), just never applied to the manual button.

**Fix:** `20260915120000_release_withdrawal_claim_frees_float.sql` — a new
`release_withdrawal_claim(p_withdrawal_id, p_reason)` RPC that clears the assignment **and**
calls `release_merchant_float()` in one transaction. Refuses to release a claim with
settlement already in progress (proof/TID/payout code present), mirroring the same
zero-progress gate `release_stale_cashout_claims()` already applies — releasing a payout
mid-settlement risks the customer being paid twice. `WithdrawalPayoutCard.tsx` now calls
this RPC instead of writing the table directly.

**The migration reached the repo but not the database for several hours.** This is the
same failure mode `08` and `17` already documented — pushing to `origin/lovable` does not
guarantee `supabase/migrations/` applies to production. The button was calling an RPC that
did not exist in `pg_proc` at all, which is *worse* than the original bug (a hard failure
instead of a silent float leak). Confirmed live only after being applied manually via the
Supabase SQL editor. **Before assuming this is fixed:**

```sql
SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'release_withdrawal_claim');
-- Zero orphaned reservations is the health signal, same query as doc 08:
SELECT r.id, r.withdrawal_id, r.reserved_amount
FROM public.merchant_float_reservations r
JOIN public.withdrawal_requests w ON w.id = r.withdrawal_id
WHERE r.state = 'reserved' AND w.assigned_cashout_agent_id IS NULL;
```

Both confirmed true / zero-rows as of 2026-09-15.

---

## 2. Merchant float auto-credit: two real, distinct gaps

The claim was "the system tracks the outbound company SMS to a registered merchant
number and credits it as float automatically." That mechanism (`tryAutoDebitPayout` in
`gmail-poll-transactions`, matching `cashout_agents.float_phone` and crediting via
`record_merchant_float_delivery`) is sound in isolation — see the 2026-08-17 incident report
(`docs/investigations/Merchant_Float_Incident_Report_2026-08-17.md`) item 7. Two things around
it are not.

### 2a. The match is one-shot, never retried

If a desk's `is_active`/`float_phone` registration lags behind an outbound send by even a
short window, the match at ingestion time fails and is **never retried** — even after the
desk is correctly registered minutes or days later. Confirmed live (2026-09-15, 14-day
window): 23 outbound sends totalling **UGX 51,933,040** logged `float_phone_no_match` in
`email_payout_match_attempts`. Of those, real desk-attributable gaps (excluding sends to
numbers that were never registered to any desk at all, which is correct non-credit
behaviour):

| Desk | Number | Attempts | Amount (UGX) | Note |
|---|---|---|---|---|
| Nankambo Sharimah | 0708269084 | 5 | 20,090,000 | Desk was reassigned/fixed by the agent's own account 2026-09-15 08:46 — see §3 |
| Bayo Mercy, retired "ENTEBBE" desk | 0706052465 | 6 | 16,605,000 | Retired 2026-09-07; money kept arriving on the old number afterward |
| Bayo Mercy, active "Entebbe" desk | 0777313372 | 2 | 7,000,000 | Fixed 2026-09-11 |
| Mulungi Aidah | 0702874567 | 2 | 2,000,000 | Already reconciled through a different path by the time this was checked — false positive in this list |

**Fix:** `20260915150000_merchant_float_selfheal_on_desk_activation.sql` — a trigger on
`cashout_agents` (`AFTER INSERT OR UPDATE OF is_active, float_phone`) that immediately
re-attempts the match for that phone number over a **24-hour trailing window only**. It never
reaches backward past that window, so it can never retroactively credit an old backlog —
it starts working "the next time that desk receives float," not immediately. It also
**refuses outright** for any desk carrying an unevidenced `merchant_float_reconciliations`
row (`evidence_note` empty) — a generic, self-updating guard, not a hardcoded exclusion list.

**⚠️ NOT YET APPLIED TO PRODUCTION as of 2026-09-15.** Confirm before relying on it:

```sql
SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'catch_up_merchant_float_delivery'),
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'cashout_agent_float_catchup');
-- Both must be true. As of 2026-09-15 both are false.
```

### 2b. Retired desks are invisible on the FinOps board — by design, not by bug

`get_merchant_float_positions(p_include_retired boolean DEFAULT false)` excludes retired
desks by default, and both frontend call sites (`useMerchantFloat.ts`,
`WalletBucketHoldersPanel.tsx`) call it with no argument. `MoneyWithAgentsCard.tsx` also has
its own explicit filter: `data.filter(r => r.isActive)`, commented *"ONLY active
merchant/cash-out desks belong on this board... even when it still has residual figures."*
This is deliberate, not a bug — confirmed and explicitly left as-is per Josh, 2026-09-15.
Consequence to remember: Bayo Mercy's retired ENTEBBE desk holds a real, ledger-backed
UGX 6,500,000 that will never appear on this board while retired. If a "money the company
can't currently see" audit is ever needed, query `cashout_agents` directly rather than
trusting this board's total.

---

## 3. Do not auto-credit the two flagged desks — this was a deliberate decision, not an oversight

Both Nankambo Sharimah's and Bayo Mercy's desks carry unevidenced
`merchant_float_reconciliations` rows (10 of 11 and 4 of 14 respectively, `evidence_note`
empty) — the same insider-correction pattern documented in the 2026-08-17 report (Bayo Mercy
authoring "Balance correction" rows across 16 desks with no finance authority, including on
Sharimah's own desk). Both are internal/employee accounts, not ordinary external merchant
agents. **Josh's explicit instruction (2026-09-15): leave their missing float uncredited —
do not touch it.** The self-heal trigger in §2a is built so it structurally cannot reach
this backlog (24h window + reconciliation-dispute guard), so it will not violate this even
once applied.

Also worth flagging for whoever picks this up: Sharimah's `cfo_merchant_agent_assigned`
audit row from 2026-09-15 08:46 was performed **by her own account** (`user_id` on that row
equals her own `agent_id`), not by a CFO actor — she has enough internal access to
reconfigure her own merchant desk. Treat any future registration changes on flagged desks as
self-service, not administrative.

---

## 4. A genuine bug found while investigating: false "critical" alerts on a benign race

Separate from the crediting gap: `deposit_match_alerts` (`alert_type =
'merchant_float_uncredited'`) had **25 unresolved rows going back to 2026-08-15**, total
UGX 43,529,000, split:

| Stage | Alerts | Amount (UGX) | Real? |
|---|---|---|---|
| `unlinked_backstop_detected_no_credit` | 10 | 21,090,000 | **Yes, all 10** — checked every TID against `merchant_float_deliveries` and `general_ledger`, none credited |
| `linked_pending_sweep_failed` | 15 | 22,439,000 | **No — 14 of 15 were false positives** |

The false positives: `sweepLinkedPendingDeposits` (in `gmail-poll-transactions`) retries
crediting any `deposit_requests` row still `status='pending'` from its own batch `SELECT`,
run every 2 minutes. It races against the immediate on-ingestion credit path
(`tryAutoCreditOperationalFloat`) crediting the *same* deposit moments earlier. When the
sweep loses the race, `approve-deposit` correctly refuses — either because the deposit is no
longer `pending` (already `approved`), or because the ledger's duplicate-TID guard fires
(`"Duplicate TID ... already credited ... Refusing to double-credit"`) — but any non-200
response was logged as a `severity: 'critical'` alert regardless of *why* it failed. A benign,
by-design refusal looked identical to a real loss. Checked all 15: 6 were already `approved`
(credited fine via the other path), 6 were already `failed` with a rejection reason
containing "Duplicate TID... already credited," 2 were `rejected` with "Already credited from
your mobile-money receipt," and exactly **1 was genuinely stuck** — a UGX 3,000,000 MTN
deposit for a non-merchant user, `status='pending'` since 2026-08-17, never retried again
because it had aged out of `sweepLinkedPendingDeposits`'s 7-day lookback window.

**Fix (committed, code-only, no migration — verify the edge function actually redeployed):**
`sweepLinkedPendingDeposits` now (1) re-reads the deposit's live status immediately before
calling `approve-deposit`, skipping and resolving the alert if another path already closed it
out, and (2) on a non-200 response, checks the body for the known benign-duplicate signature
and resolves the alert instead of raising a new critical one when found.

**Not fixed:** the one genuine stuck deposit (2026-08-17, UGX 3,000,000, MTN, a non-merchant
user) is still sitting `pending` — it needs a manual credit or rejection decision, not an
automated one. The 13 stale false-positive alert rows already in `deposit_match_alerts` were
**not** bulk-cleared — an attempt to do so via a direct `UPDATE` was blocked by the sandbox's
write-safety classifier; they'll still show as open until either resolved by hand or picked
up incidentally the next time something touches those specific rows.

**Structural gap, not fixed:** `deposit_match_alerts` has zero frontend consumers — grepped
`src/` for `merchant_float_uncredited`, `linked_pending_sweep_failed`, and
`unlinked_backstop_detected_no_credit`: no matches anywhere. Every alert this table has ever
held has been invisible to Financial Ops from day one; the table is not a "nobody's watching
a dashboard" problem, it's a "there is no dashboard" problem.

---

## 5. Poll cadence reduced 2min → 1min

Separately measured while investigating the above: end-to-end latency (SMS sent → float
credited) is dominated by IFTTT's own SMS-forwarding delay, not this platform's poll. Median
IFTTT lag 0.6 min, but p95 40.3 min and worst case 62.8 min over a 5-day sample — consistent
with IFTTT's free-tier roughly-hourly trigger-check ceiling. Welile's own poll+credit latency
was already fast (median ~40s, p95 ~2min). Reduced the cron
(`gmail-poll-transactions-every-2min` → `gmail-poll-transactions-every-1min`, jobid 38681)
to shave the small part that is actually ours; this does not and cannot touch the IFTTT-side
tail. **Applied directly to production** via `cron.unschedule` + `cron.schedule` — confirmed
live. `20260915140000_gmail_poll_every_1min.sql` documents it for the repo.

---

## What's still open

1. **Self-heal trigger not applied to production** (§2a) — apply
   `20260915150000_merchant_float_selfheal_on_desk_activation.sql` and re-run the check query
   above before assuming any future registration-lag gap will self-heal.
2. **The one genuine stuck deposit from 08-17** (§4) needs a manual finance decision.
3. **13 stale false-positive alerts** in `deposit_match_alerts` are still marked unresolved
   and need a bulk clear (blocked once by the sandbox this session — a human or a
   differently-scoped write should do it).
4. **No UI reads `deposit_match_alerts` at all.** Any future "why didn't we see this
   coming" question about merchant float has the same answer until this changes.
5. **`sweepLinkedPendingDeposits`'s edge-function deploy was not independently verified** —
   the code fix in §4 was committed and pushed; confirm the deployed `gmail-poll-transactions`
   function actually reflects it (edge functions here have separately been found to diverge
   from repo — see `docs/HANDOVER/17-critical-function-drift-detection.md`).

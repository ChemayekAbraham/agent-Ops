# 8. Incident — Merchant claims failed, and the retry destroyed the claim (2026-09-11 → 12)

**Severity:** P1. Merchant Agents could not reliably claim withdrawals; customers were told "your
money is being processed" for payouts nobody was holding.

**All figures in this document were read from the production Postgres catalog between
2026-09-11 22:00 UTC and 2026-09-12 00:20 UTC** (01:00–03:20 EAT). Re-run the SQL in
[§ Is the fix still live](#is-the-fix-still-live) before trusting any of it.

---

## What people saw

Merchant Agents (confirmed for **Tugabirwe Apophia** and **Brian Kagumba**) reported: tap **Claim**,
the withdrawal disappears from the Pending Queue, and either an error appears or nothing does — and
the payout never shows under **Claimed by you**. The developer's own account worked fine.

The reported cause was "network issues". That was wrong, and believing it cost a day.

---

## What was actually wrong

### Cause 1 — a retry destroyed the merchant's own claim (the main one)

`claim_withdrawal_verified` reserved float **before** checking who owned the row. When the UPDATE
matched zero rows it called `release_merchant_float(withdrawal, 'claim_race_lost')`.

If the *same* merchant sent the claim twice — lost HTTP response, double tap, browser retry — the
second call found the row already assigned **to that merchant**, and released **their own live
reservation**, then answered `already_claimed` ("claimed by another agent").

The merchant was told their claim failed. It had succeeded. Their float was freed anyway.

> **Every single `claim_race_lost` row in the 24 hours before the fix — 23 of them — was a merchant
> retrying their own successful claim. Not one was a real two-merchant race.**

| Merchant | Self-retries | Value affected (UGX) |
|---|---|---|
| Babrah Tusingwire | 10 | 3,566,839 |
| Tugabirwe Apophia | 7 | 7,593,840 |
| Nabbale Claire | 3 | 1,635,000 |
| Brian Kagumba | 1 | 10,000 |
| Mudumba Samuel | 1 | 400,000 |
| Mulungi Aidah | 1 | 20,000 |

Brian's row, to the second (UTC):

| Time | Event |
|---|---|
| 20:12:06.661 | claim succeeds, reservation row created |
| 20:12:07.783 | customer SMS "your withdrawal is being processed" — proof his phone saw success |
| 20:12:29.731 | his own retry re-reserves and releases as `claim_race_lost` |
| 21:00:00.628 | the stale-claim cron takes the claim away entirely (Cause 3) |

### Cause 2 — three different claim implementations, only one reserved float

| Path | Reserved float? |
|---|---|
| `claim_withdrawal_verified` (queue Claim button) | yes |
| `accept_withdrawal_dispatch` (dispatch pop-up, mounted app-wide) | **no** |
| `MerchantReconcilePaymentCard` — direct `UPDATE` from the browser | **no** |

So a withdrawal could be assigned with no reservation behind it at all.

### Cause 3 — the stale-claim cron silently revokes claims and leaves the float locked

`release_stale_cashout_claims()` (cron `release-stale-cashout-claims`, every 5 minutes) returns any
claim older than **45 minutes** with zero settlement evidence to the shared queue. It does **not**
notify the merchant, and it does **not** release their float reservation.

This is what makes a claimed payout "disappear". At the time of the incident **14 reservations were
locking float on withdrawals nobody held** — Apophia alone had **UGX 1,131,800** of her UGX 2,499,000
frozen this way.

**This cause is NOT fixed.** See [§ Still broken](#still-broken).

### Why the developer never saw it

Development and production share the same database. The difference was behaviour, not environment:
the bug needs either a retry after a successful claim (a phone on a weak network) or more than 45
minutes before proof is entered. A desktop test does neither.

---

## What was changed

One migration: **`supabase/migrations/20260912010000_canonical_merchant_claim.sql`**, applied to
production 2026-09-12 ~22:22 UTC (01:22 EAT).

`claim_withdrawal_verified` is now the single claim transaction:

```text
lock merchant (advisory) → lock withdrawal row FOR UPDATE
  → classify: mine (idempotent success) / another desk's / closed
  → one-active-claim → channel+category permission → priority holds → payout details
  → [savepoint: release any orphan reservation → reserve float → assign → assert ownership]
  → write claim-attempt log → return the FULL claimed withdrawal
```

Key guarantees:

- **A retry of your own claim returns success**, `idempotent: true`, and changes nothing. It never
  reserves again and never releases.
- **The loser of a real race never touches the winner's reservation.**
- **Reserve and assign are one unit.** Either both happen or neither does.
- **The response carries the whole claimed withdrawal**, so the UI shows it without a second read.
- `accept_withdrawal_dispatch` is now a thin wrapper over the same transaction (same `ok` key, so
  old open tabs keep working).
- New `get_withdrawal_claim_status(uuid)` answers "who owns this now?" without revealing which other
  desk holds it — the frontend uses it when a response is lost instead of declaring failure.
- New table `withdrawal_claim_attempts` records **every** attempt with a result code.

Frontend (`AgentCashPayoutsTab`, `MerchantDispatchListener`, `MerchantReconcilePaymentCard`,
`src/lib/merchantClaim.ts`): every Claim tap now ends in an explicit visible state, the returned
claim is written straight into "Claimed by you", and a timeout is treated as UNKNOWN — never as
"claim failed". The reconcile card no longer writes the assignment from the browser.

Also added: a build identifier at `window.__WELILE_BUILD__`, `<html data-build>` and
`/build-info.json`, so "is production running the code we tested?" is answerable.

---

## How we know it works

**Automated** — `scripts/test-merchant-claim-canonical.mjs` runs against a real embedded Postgres
(genuine concurrency, real row locks): 48/48 pass, including 30 rounds of two merchants claiming the
same withdrawal simultaneously and 15 double-tap rounds. It first reproduces the old bug on the old
function, then applies the migration and proves it gone. `src/lib/__tests__/merchantClaim.test.ts`
covers the client outcomes: 27/27.

**Live, the same night:**

| Merchant | Amount | Claimed | Paid | TID | Outcome |
|---|---|---|---|---|---|
| Brian Kagumba | UGX 5,000 | 01:43:55 EAT | 01:56:15 | 43444419513 | `CLAIM_SUCCESS`, no retry, no race |
| Joshua Wanda | UGX 40,000 | 02:09:42 EAT | 02:16:42 | 43444463485 | `CLAIM_SUCCESS`, `orphan_released_then_reserved` |

Joshua's is the interesting one: that withdrawal still carried **Bayo Mercy's** stale UGX 40,500
reservation. The new code released the orphan and reserved for Joshua before assigning. Under the old
code he would have inherited her reservation and the payout would have been booked as *her* out-of-pocket
money — the same defect that produced 29 misattributed receivables worth ~UGX 21.3M in August.

Brian also hit `CLAIM_BLOCKED_ACTIVE_CLAIM` at 01:50:48 when he tried to claim a second payout while
holding the first — the rule working, and now visible in the log instead of invisible.

---

## Is the fix still live

```sql
-- All four must be true. If any is false, the migration is not applied.
SELECT
  position('CLAIM_ALREADY_OWNED_BY_SELF' in pg_get_functiondef(
    'public.claim_withdrawal_verified(uuid,text,text)'::regprocedure)) > 0 AS idempotent_branch,
  position('claim_withdrawal_verified' in pg_get_functiondef(
    'public.accept_withdrawal_dispatch(uuid)'::regprocedure)) > 0        AS dispatch_delegates,
  to_regclass('public.withdrawal_claim_attempts') IS NOT NULL            AS attempt_log_exists,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_withdrawal_claim_status') AS status_rpc_exists;
```

```sql
-- What merchants are actually hitting. This replaces asking them.
SELECT a.created_at, p.full_name, a.result_code, a.error_code,
       a.idempotent, a.race_lost, a.reservation_outcome
FROM public.withdrawal_claim_attempts a
LEFT JOIN public.profiles p ON p.id = a.agent_user_id
ORDER BY a.created_at DESC LIMIT 50;
```

```sql
-- The invariant. Must return zero rows: an open claim whose reservation
-- is missing, released, or owned by somebody else.
SELECT w.id, w.assigned_cashout_agent_id, r.state, r.agent_id
FROM public.withdrawal_requests w
JOIN public.cashout_agents ca ON ca.id = w.assigned_cashout_agent_id
LEFT JOIN public.merchant_float_reservations r ON r.withdrawal_id = w.id
WHERE w.status IN ('pending','requested','manager_approved','cfo_approved','approved','fin_ops_approved')
  AND w.processed_at IS NULL AND COALESCE(w.fin_ops_reference,'') = ''
  AND (r.id IS NULL OR r.state <> 'reserved' OR r.agent_id <> ca.agent_id);
```

**Rollback:** re-run the two previous function definitions, captured verbatim in
`scripts/fixtures/merchant-claim-prod-baseline-2026-09-12.sql`. The new table and helpers can stay.

---

## Still broken

| # | Problem | Evidence |
|---|---|---|
| 1 | **The 45-minute stale release still revokes claims silently and still leaves float locked.** It took Emma Maiso's UGX 95,000 at 01:40 EAT on 2026-09-12; her UGX 27,000 reservation stayed `reserved`. The repair exists as `20260911210000` but is **not applied**. | `release_stale_cashout_claims()` has no `release_merchant_float` call |
| 2 | **Manual "Release back to queue"** clears the assignment without releasing float. | `WithdrawalPayoutCard.tsx` |
| 3 | **Merchants can still write claim fields directly** — the RLS UPDATE policy on `withdrawal_requests` permits it. | `"Active merchant agents can claim or release payouts"` |
| 4 | **1,575 completed payouts sit `unsettled` with `missing: merchant_telecom_charge`**, oldest 2026-07-16. 1,574 predate this fix, so it is a long-standing pattern, not a regression. Likely a false positive for zero-float merchants, who have no float leg to find. | `settlement_missing_legs` |
| 5 | **The reconcile card's candidate query selects a non-existent column** (`payment_method`), so its list is always empty. | `MerchantReconcilePaymentCard.tsx` |
| 6 | `auto_dispatch_withdrawals` assigns without reserving float. Nothing schedules it today. | function body |

---

## What not to do

- **Do not diagnose this class of failure as "network issues".** A weak network is the *trigger*; the
  damage was server-side. A payment system must survive a repeated request.
- **Do not "clean up" reservation rows by hand.** An orphaned reservation is released by claiming the
  row (the claim function repoints it) or by the 48-hour sweep — never by editing state.
- **Do not assume a migration in the repo is applied.** On 2026-09-11 three pushed migrations
  (`20260911190000`, `200000`, `210000`) sat unapplied for a day while production ran the old
  functions; on 2026-09-12 the next push auto-applied within two minutes. Applied migrations are also
  **not** recorded in `supabase_migrations.schema_migrations`. Verify the live objects, always.
- **Do not widen the claim RPC's response** to include another desk's customer data. `mine` returns
  the payout; `other` deliberately returns nothing but the state.

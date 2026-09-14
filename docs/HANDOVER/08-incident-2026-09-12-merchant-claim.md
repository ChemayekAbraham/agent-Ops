# 8. Incident — Merchant claims failed, and the retry destroyed the claim (2026-09-11 → 12)

**Severity:** P1. Merchant Agents could not reliably claim withdrawals. Customers were told "your
money is being processed" for payouts that nobody was holding.

**Everything below was read from the production Postgres catalog between 2026-09-11 22:00 UTC and
2026-09-12 03:45 UTC.** Re-run the SQL in [§ Is the fix still live](#is-the-fix-still-live) before
trusting any of it.

---

## The one-sentence cause

Merchant phones on weak networks retried claims that had **already succeeded**, and the server
responded by destroying the merchant's own float reservation and telling them another agent had
taken it — then, 45 minutes later, silently confiscated the claim entirely.

It was never one bug. It was one trigger meeting six defects, plus a delivery failure that made
every attempted fix invisible.

---

## What people saw

Merchant Agents (confirmed for **Tugabirwe Apophia** and **Brian Kagumba**) reported: tap **Claim**,
the withdrawal disappears from the Pending Queue, and either an error appears or nothing does — and
the payout never shows under **Claimed by you**. The developer's own account worked fine.

The reported cause was "network issues". That was wrong, and believing it cost a day.

---

## The trigger

Merchants work on phones, on Ugandan mobile networks, at night. Requests time out. Responses are
lost *after* the server has committed. People tap twice when nothing happens.

None of that is unusual and none of it should matter. A payment system must survive a repeated
request. This one did not.

---

## Cause 1 — the retry destroyed the claim it was retrying

`claim_withdrawal_verified` reserved float **before** checking who owned the withdrawal, then
assigned the row guarded by `WHERE assigned_cashout_agent_id IS NULL`. Zero rows matched was assumed
to mean "another merchant beat me", so it called
`release_merchant_float(id, 'claim_race_lost')`.

On a retry by the **same merchant** the row was no longer null — it was already theirs. Zero rows
matched. The server released **their own live reservation** and answered *"Already claimed by
another agent."*

> Every one of the **23 `claim_race_lost` events in the 24 hours before the fix was a merchant
> retrying their own successful claim.** Not one was a genuine two-merchant race.

| Merchant | Self-retries | Value caught up (UGX) |
|---|---|---|
| Babrah Tusingwire | 10 | 3,566,839 |
| Tugabirwe Apophia | 7 | 7,593,840 |
| Nabbale Claire | 3 | 1,635,000 |
| Mudumba Samuel | 1 | 400,000 |
| Mulungi Aidah | 1 | 20,000 |
| Brian Kagumba | 1 | 10,000 |

**Brian's 79 seconds**, exactly as recorded (EAT):

| Time | Event |
|---|---|
| 23:10:53 | becomes a Merchant Agent |
| 23:12:06 | claim **succeeds**, reservation row created |
| 23:12:07 | customer SMS *"your withdrawal is being processed"* — proof his phone saw success |
| 23:12:29 | his own retry releases his reservation; screen says another agent took it |
| 00:00 | the stale-claim cron confiscates the claim entirely (Cause 3) |

## Cause 2 — a partial fix fell through to a worse one

The one-active-claim lookup deliberately excluded the same withdrawal (`w.id <> p_withdrawal_id`),
which correctly avoided telling a retrying merchant "you already have a payout in progress".

Having dodged the confusing error, the code fell straight through into Cause 1. It avoided a wrong
message and delivered a damaging one instead.

## Cause 3 — why claims *disappeared*

`release_stale_cashout_claims()` (cron `release-stale-cashout-claims`, every 5 minutes) returns any
claim older than **45 minutes with zero settlement evidence** to the shared queue. It does **not**
notify the merchant, does **not** release their float, and writes no per-withdrawal audit row.

The payout simply vanishes from the screen while the merchant is still working it. Apophia's
UGX 1,000,300 payout for Lukodda Joseph was claimed and silently taken back **five times** between
19:17 and 23:10 EAT.

**The float-release half of this was fixed 2026-09-14** (`20260914230000`) — see the updated
[§ Still broken](#still-broken) item 1. The claim-disappears-silently / no-merchant-notification part
is still exactly as described here.

## Cause 4 — three claim paths, only one reserved float

| Path | Reserved float? |
|---|---|
| `claim_withdrawal_verified` (queue Claim button) | yes |
| `accept_withdrawal_dispatch` (dispatch pop-up, mounted app-wide) | **no** |
| `MerchantReconcilePaymentCard` — direct `UPDATE` from the browser | **no** |

A withdrawal could be assigned with nothing backing it.

## Cause 5 — how this became lost money

`reserve_merchant_float` accepted **any** existing non-released reservation as "already mine",
regardless of who owned it. Combined with the orphans left by Causes 1 and 3, the next merchant to
claim that row inherited someone else's reservation, and the payout was booked as the **wrong
merchant's** out-of-pocket cash.

That is the origin of the ~UGX 21.3M of receivables misattributed to non-settlers in August. Same
root, months of consequences.

## Cause 6 — the frontend turned "unknown" into "failed"

Claiming and displaying were separate operations. The instant a claim committed the row left the
Pending Queue (that list requires `assigned_cashout_agent_id IS NULL`), and a **second** request had
to fetch it back into "Claimed by you". If that request was slow or failed, the merchant watched the
payout vanish with nothing in its place.

Worse, any timeout was reported as *"the claim failed"* — a definite statement about money, made
with no knowledge of what the server had done.

---

## Why it survived a whole day of attempted fixes

This is the most important section in this document.

**1. Migrations reached the repo but never the database.** Three migrations — the merchant RLS fix
(`20260911190000`), reservation ownership (`20260911200000`) and the float-release repair
(`20260911210000`) — were pushed to `origin/lovable` on 2026-09-11 and were **never applied to
production**. Six commits claimed the problem was solved. The database went on running the old
function. Nothing changed because nothing was running.

The next day's push auto-applied within two minutes. **Same mechanism, opposite outcome** — so never
infer application from a file's presence, in either direction. Applied migrations are also **not**
recorded in `supabase_migrations.schema_migrations`, so that table cannot settle it either.

**2. There was no server-side evidence.** Not one record of a claim attempt existed. All anyone
could see were network errors in the browser, so "network issues" was the only conclusion available.
The network was the trigger, never the cause — but with no telemetry that was unprovable. This is
why `withdrawal_claim_attempts` now exists.

## Why the developer never reproduced it

Same database, same build. The difference was behaviour: on a desktop, on a good connection,
entering the TID promptly, you never retry and never cross 45 minutes. The bug needed one of those
two things.

---

## The solution

One migration: **`supabase/migrations/20260912010000_canonical_merchant_claim.sql`**, applied to
production 2026-09-11 ~22:22 UTC (2026-09-12 01:22 EAT).

`claim_withdrawal_verified` is now the single claim transaction:

```text
lock merchant (advisory) → lock withdrawal row FOR UPDATE
  → classify: mine (idempotent success) / another desk's / closed
  → one-active-claim → channel+category permission → priority holds → payout details
  → [savepoint: release any orphan reservation → reserve float → assign → assert ownership]
  → write claim-attempt log → return the FULL claimed withdrawal
```

| Cause | How it is now prevented |
|---|---|
| 1 | Ownership is classified **before** any money moves. A retry of your own claim returns `success` + `idempotent: true` and changes nothing — no reserve, no release. |
| 2 | The "already mine" branch returns success outright; there is no fall-through. |
| 3 | **Not fixed.** Repair written, not applied. |
| 4 | `accept_withdrawal_dispatch` delegates to the same transaction; the reconcile card calls the RPC instead of writing the table. |
| 5 | A leftover reservation belonging to another desk is released and re-reserved for the actual claimant (`orphan_released_then_reserved`), and the transaction asserts the winner owns the reservation before returning. |
| 6 | The RPC returns the whole claimed withdrawal, so the UI renders it with no second read. A lost response is reconciled through `get_withdrawal_claim_status` and reported as UNKNOWN — *"do not pay the customer until the claim status is confirmed"* — never as failure. |

Reserve and assign are one savepoint: either both happen or neither does. Every attempt — success or
refusal — is written to `withdrawal_claim_attempts` with a result code.

Also added: a build identifier at `window.__WELILE_BUILD__`, `<html data-build>` and
`/build-info.json`, so "is production running the code we tested?" is answerable in one command.

---

## How we know it works

**Automated** — `scripts/test-merchant-claim-canonical.mjs` runs against a real embedded Postgres
(genuine concurrency, real row locks): **48/48 pass**, including 30 rounds of two merchants claiming
the same withdrawal simultaneously and 15 double-tap rounds. It first reproduces the old bug against
the old function, then applies the migration and proves it gone.
`src/lib/__tests__/merchantClaim.test.ts` covers the client outcomes: **27/27**.

**Live, the same night:**

| Merchant | Amount | Claimed (EAT) | Paid | TID | Outcome |
|---|---|---|---|---|---|
| Brian Kagumba | UGX 5,000 | 01:43:55 | 01:56:15 | 43444419513 | `CLAIM_SUCCESS`, no retry, no race |
| Joshua Wanda | UGX 40,000 | 02:09:42 | 02:16:42 | 43444463485 | `CLAIM_SUCCESS`, `orphan_released_then_reserved` |

Joshua's is the significant one: that withdrawal still carried **Bayo Mercy's** stale UGX 40,500
reservation. The new code released the orphan and reserved for Joshua before assigning. Under the old
code he would have inherited it and his payout would have been booked as *her* own-cash receivable —
Cause 5, caught live.

Brian also hit `CLAIM_BLOCKED_ACTIVE_CLAIM` at 01:50:48 trying to claim a second payout while holding
the first: the rule working, and now visible instead of silent.

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

-- Nothing in the database should write this reason any more. Expect NULL.
SELECT string_agg(p.oid::regprocedure::text, ', ')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f'
  AND pg_get_functiondef(p.oid) LIKE '%claim_race_lost%';

-- Still broken item 1 (float leak on stale release), fixed 20260914230000.
-- Expect true. If false, the fix has regressed.
SELECT position('release_merchant_float' in pg_get_functiondef(
  'public.release_stale_cashout_claims()'::regprocedure)) > 0 AS stale_release_frees_float;

-- Zero orphans: a reservation still 'reserved' whose withdrawal is no longer
-- assigned to that (or any) agent. Expect zero rows. If any come back, the
-- fix above is not running, or a new code path has reintroduced the leak.
SELECT r.id AS reservation_id, r.withdrawal_id, r.reserved_amount
FROM public.merchant_float_reservations r
JOIN public.withdrawal_requests w ON w.id = r.withdrawal_id
WHERE r.state = 'reserved' AND w.assigned_cashout_agent_id IS NULL;
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
-- The invariant. Must return zero rows: an open claim whose reservation is
-- missing, released, or owned by somebody else.
SELECT w.id, w.assigned_cashout_agent_id, r.state, r.agent_id
FROM public.withdrawal_requests w
JOIN public.cashout_agents ca ON ca.id = w.assigned_cashout_agent_id
LEFT JOIN public.merchant_float_reservations r ON r.withdrawal_id = w.id
WHERE w.status IN ('pending','requested','manager_approved','cfo_approved','approved','fin_ops_approved')
  AND w.processed_at IS NULL AND COALESCE(w.fin_ops_reference,'') = ''
  AND (r.id IS NULL OR r.state <> 'reserved' OR r.agent_id <> ca.agent_id);
```

> **Counting trap.** Do not count `claim_race_lost` rows by `updated_at`. Reconciliation jobs bump
> that column on old rows in bulk — on 2026-09-12 at 03:40 UTC seven of yesterday's rows were touched
> at once, which looks exactly like a fresh outbreak. Count by `reserved_at` / `created_at`, and
> confirm against the function bodies with the query above.

**Rollback:** re-run the two previous function definitions, captured verbatim in
`scripts/fixtures/merchant-claim-prod-baseline-2026-09-12.sql`. The new table and helpers can stay.

---

## Still broken

| # | Problem | Evidence |
|---|---|---|
| 1 | **FIXED 2026-09-14 (`20260914230000`).** The 45-minute stale release now calls `release_merchant_float()` for every withdrawal it returns to the pool. Two independent production audits on 2026-09-14 found this gap was still live and not dormant — a second, different real instance (a different withdrawal, `4551f812-...`, UGX 20,700, claimed 2026-09-13 14:14:57 UTC) was found stuck in exactly this state ~17 hours later and manually released via the canonical `release_merchant_float()` RPC (not a hand-edit — verified via a full reserved-but-unassigned scan that it was the only orphan, and confirmed `state = 'released'` afterward) before the fix was written. Re-run the query in [§ Is the fix still live](#is-the-fix-still-live) to confirm `release_merchant_float` still appears in this function's body — it did not, twice, for over 48 hours after this was first documented. Still remains: claim release still does not notify the merchant. | `release_stale_cashout_claims()` |
| 2 | **Manual "Release back to queue"** clears the assignment without releasing float. | `WithdrawalPayoutCard.tsx` |
| 3 | **Merchants can still write claim fields directly** — the RLS UPDATE policy on `withdrawal_requests` permits it. | policy `"Active merchant agents can claim or release payouts"` |
| 4 | **1,575 completed payouts sit `unsettled` with `missing: merchant_telecom_charge`**, oldest 2026-07-16. 1,574 predate this fix, so it is long-standing, not a regression. Likely a false positive for zero-float merchants, who have no float leg to find. | `settlement_missing_legs` |
| 5 | **The reconcile card's candidate query selects a non-existent column** (`payment_method`), so its list is always empty. | `MerchantReconcilePaymentCard.tsx` |
| 6 | `auto_dispatch_withdrawals` assigns without reserving float. Nothing schedules it today. | function body |

---

## What not to do

- **Do not diagnose this class of failure as "network issues".** A weak network is the *trigger*; the
  damage was server-side. Read `withdrawal_claim_attempts` before asking the merchant anything.
- **Do not hand-write a raw `UPDATE merchant_float_reservations SET state = ...`.** If you find an
  orphaned `reserved` row whose withdrawal is no longer assigned to any agent, release it through
  `release_merchant_float(withdrawal_id, reason)` — it is idempotent, refuses if the reservation was
  already consumed, and is the same function `release_stale_cashout_claims()` now calls automatically
  (see item 1, fixed 2026-09-14). Verify the withdrawal really is unassigned with zero settlement
  progress first, exactly as the automated sweep's own WHERE clause does.
- **Do not assume a migration in the repo is applied — or that it is not.** Both have happened within
  24 hours. Verify the live objects, every time.
- **Do not widen the claim RPC's response** to include another desk's customer data. `mine` returns
  the payout; `other` deliberately returns nothing but the state.
- **Do not force-release a claim inside its normal working window.** Check `dispatched_at`. Forcing a
  release on a payout that is mid-flight risks paying the same customer twice.

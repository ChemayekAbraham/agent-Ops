# Arrears phase 2 — shipped

**Applied to production 9 September 2026, ~15:10 EAT.** Migration file:
`supabase/migrations/20260909170000_agent_collect_context_phase2.sql`.

Phase 1 started *recording* which day each collection settles
([`arrears-phase1-shipped.md`](./arrears-phase1-shipped.md)). Phase 2 *shows it
to the agent* — on their dashboard, and in the confirmation step when they press
pay.

Like phase 1, nothing here changes what anyone owes, what any target reads, or
what the eligibility gate measures. It is display plus one read function.

---

## Your question first: no, it does not need a time gate

You were right. The arrears views are floored at `rent_arrears_go_live()`
(2026-09-10), so **today every arrears figure is 0 and every list is empty** —
there is no N and no X to show. The UI renders the arrears block only when there
is something in it, so the empty queue *is* the gate. No date check in the
frontend, nothing to remember to switch on at midnight, and no risk of a
half-populated first day.

Verified against production, on a real plan billed for today:

```
expected_today     68,000     ← still comes through normally
days_behind             0
arrears_ugx             0
behind_days            []
due_today_ugx           0
```

The agent sees exactly the screen they see now. Rehearsed the same payload with
the floor pretended to be seven days back and it fills in correctly
(`days_behind: 7`, `arrears_ugx: 1,246,000`, seven itemised days, oldest first) —
so the display is proved on both sides of the boundary without touching the real
floor.

---

## What was built

### Backend — one function, and one gap closed

**`agent_collect_context(rent_request_id)`** returns everything the collect
screen needs in **one round trip**: today's amount, days behind, arrears, what is
still due today, any money paid ahead, and the behind days itemised oldest first.

The round-trip count did not go up. The dialog already made exactly one call
(`agent_expected_collection`) to learn today's amount; it now makes exactly one
call that answers both questions. **Arrears cost zero extra calls.**

`expected_today` is not a reimplementation — the function *calls*
`agent_expected_collection` internally. There stays one definition of "what is
due today", shared by the screen, this dialog and the allocation RPC's shortfall
stamping, so they cannot drift apart. Inside, one materialised pass over the
plan's days feeds every figure rather than one query per field.

**`rent_plan_collect_authorized(rent_request_id)`** is the new read gate, and it
closed a real gap in phase 1. The collection path lets three parties collect on a
plan: the owning agent, the assigned agent, and **a parent agent whose verified
sub-agent holds it**. Phase 1's `rent_plan_day_ledger` gated on owner/assigned
only — so a parent agent collecting for a sub-agent's tenant could take the
money but could not see the days behind it. The gate now mirrors the collection
path's test exactly, and `rent_plan_day_ledger` was moved onto it.

Both are `STABLE SECURITY DEFINER`, read-only, and `anon` is revoked (Postgres
grants EXECUTE to PUBLIC by default; they already gated on `auth.uid()`, but a
signed-out session has no business reaching a tenant's ledger at all).

### Frontend

| File | What it is |
| --- | --- |
| `src/lib/arrearsAllocation.ts` | Pure preview of where a payment lands, mirroring the server's FIFO rule. No arrears arithmetic of its own — it partitions the amount typed across totals the server supplied. |
| `src/lib/arrearsAllocation.test.ts` | 12 tests over that arithmetic. |
| `src/hooks/useAgentArrears.ts` | The two reads (`agent_collect_context`, `agent_arrears_overview`) plus an invalidator. |
| `src/components/agent/AgentArrearsCard.tsx` | The agent's own "unpaid days to recover" tile, expanding to the tenants behind. |
| `src/components/agent/AgentTenantCollectDialog.tsx` | Wired to the single call; arrears explained on the form and split out on confirm. |
| `src/components/agent/AgentActionInsights.tsx` | Mounts the card under the daily-rent tile. |

**What the agent sees when a tenant is behind.** On the amount form: *Behind 3
days · UGX 1,500 unpaid* — and that older days settle first, so part of whatever
they collect goes there before it counts for today, with no extra charge. On the
confirmation step, the exact amount broken into where it will land:

```
→ Older unpaid days  (clears 2 of 3)     UGX 1,000
→ Today                                  UGX 3,500
→ Paid ahead                             UGX 0
```

The three lines always add back to the amount. When the older days take
everything, it says so plainly: *the older days take all of it, so today stays
open. The money is not lost — it has cleared the days behind.*

**The screen still offers only today's amount.** The suggested figure and the
"Collect full" button are unchanged — as agreed. An agent who wants to clear
arrears types a larger number and the split shows what it does. Nothing nudges
them to collect more than the day's schedule.

The card and both dialog blocks render nothing when there are no arrears, so
today they are invisible.

---

## One consequence to expect, by design

When a tenant is behind and the agent collects **exactly today's amount**, the
oldest-day-first rule sends that money to the older day — so the receipt is a
full day's collection while **today stays open**. That is the rule working, not a
fault, and the dialog says it in those words.

It is also the exact mechanism behind §3 of
[`arrears-carry-forward-settlement-order.md`](./arrears-carry-forward-settlement-order.md):
today's *credited* figure falls while the agent brings in the same cash. It has
no effect on anything yet, because the eligibility gate still counts raw cash
collected. **That is the phase 3 decision**, and it is still blocked on the
19-agent auto-pass question.

---

## Verification

| Check | Result |
| --- | --- |
| `arrearsAllocation` unit tests | **12 passed** — partition sums back to the amount at 7 amounts, no bucket overpaid, truncated-list day counts correct |
| `AgentTenantCollectDialog` existing tests | **2 passed** (unchanged) |
| `npm run guard:all` | **all guards passed** |
| `tsc --noEmit` | clean |
| Production payload, real plan, today | zeros as shown above |
| Production payload, floor pretended 7 days back | fills in correctly, oldest day first |
| Regulatory terminology in new files | 0 hits for loan / lender / interest / ROI |
| Lint on new files | clean (the dialog's 4 pre-existing `any` errors untouched) |

The frontend writes nothing: both new reads are `SELECT`-only RPCs, and the
allocation itself still goes through `agent_allocate_tenant_payment`. After a
collection — including the "already recorded" reconcile path — the arrears
queries are invalidated, so a second collection on the same tenant can never be
talked through a stale split.

**Not exercised until tomorrow:** as with phase 1, there is no in-scope data yet,
so the dialog's arrears block has been proved by rehearsal rather than by a live
collection. First real one is after midnight EAT.

---

## Still outstanding

1. **The sweeper is still not on the cron.** `rent_sweep_unapplied_collections()`
   should run right after the 00:05 pin so money paid ahead lands on the day it
   creates. Until then it is applied on the plan's next collection instead.
   Nothing is lost either way. This is the one piece of phase 1 that was left
   unwired, and tomorrow is when it starts to matter.
2. **Phase 3** — the gate change (bill-driven denominator, today-portion
   numerator), blocked on the 19-agent question.
3. **`39976d4a`** still has no pinned day, so it cannot appear in this queue.
4. **Pre-existing, not from this work:** `src/integrations/supabase/types.ts`
   already differs from `scripts/schema-types.fingerprint.json` on the committed
   tree (advisory warning in `guard:all`). I did not touch either file and have
   not accepted the fingerprint, since that would mean vouching for a schema diff
   I did not review.

Nothing from phase 1 or phase 2 is committed yet — both migrations, the docs and
the frontend files are still local.

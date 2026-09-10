# Arrears phase 1 — shipped

**Applied to production 9 September 2026, ~15:00 EAT.** Migration file:
`supabase/migrations/20260909160000_rent_day_settlements_phase1.sql`.

Phase 1 is **behaviour-neutral**. Nothing anyone can see has changed. No target,
no eligibility percentage, no report and no screen reads differently than it did
this morning. All this does is begin recording, for every new collection, which
day it settles.

Design background: [`arrears-carry-forward-design.md`](./arrears-carry-forward-design.md)
and [`arrears-carry-forward-settlement-order.md`](./arrears-carry-forward-settlement-order.md).

---

## The rule now implemented

A payment settles the **oldest open day first**, then the next, and only what
survives lands on today. If the older days swallow the whole payment then today
receives nothing — the money is not lost, it landed on an earlier day. Surplus
beyond every open day stays unapplied and **pre-pays future days** as soon as
the pin creates them.

It never changes what a tenant owes in total. `total_repayment − amount_repaid`
remains the balance. This is attribution, not extra charges.

---

## What was built

The daily pin (`agent_expected_day_plans`, primary key `(day, rent_request_id)`)
already held **one obligation per plan per scheduled day**, written once at 00:05
EAT and never altered. That was already the queue of debts, so it was reused
rather than rebuilt. What was missing was the settlement side.

### One table

**`rent_day_settlements`** — how much of each day a given collection settled.

| Column | Meaning |
| --- | --- |
| `rent_request_id` | the Rent Plan |
| `day` | the Kampala day being settled |
| `collection_id` | the `agent_collections` row that provided the money |
| `amount` | how much of that collection landed on that day |

Two constraints carry the integrity:

- A **composite foreign key to `(day, rent_request_id)` on the pin.** A
  settlement cannot exist against a day that was never billed. This is what
  keeps the pin authoritative — and it is also why pre-payment waits as
  unapplied money rather than settling a day before it exists.
- **Unique `(collection_id, day)`**, with re-application topping the row up
  rather than duplicating it. This is what makes the allocator idempotent.

Row-level security is on and both `anon` and `authenticated` are revoked, so
every read and write goes through the functions below.

### Three views

- **`v_rent_day_ledger`** — day grain. Per plan per day from the floor forward:
  expected, settled, remaining, settled-or-not. This is the agent's checklist.
- **`v_rent_plan_arrears`** — plan grain, derived from the day ledger so the two
  can never disagree. Days behind, arrears amount, still due today, oldest open
  day. Arrears deliberately **excludes today**, which is not yet late.
- **`v_rent_collection_unapplied`** — money received since the floor and how much
  of it has been attributed. Unapplied money is what pre-pays future days.
  Derived rather than stored, so it cannot drift from the settlement rows.
  Reversed collections are excluded.

### The allocator

**`rent_apply_collections_to_days(rent_request_id)`** attributes any unapplied
money on a plan to its open days, oldest day and oldest money first.

It does this as **a single set operation — no loop, no per-day query.** Both
sides are laid out as cumulative shilling ranges: a payment covers
`[money before it, + its unapplied amount)`, a day needs
`[need before it, + its remaining amount)`, and the overlap between the two
ranges is exactly how much of that payment lands on that day. FIFO ordering
falls out of the sort.

It is idempotent by construction: it only ever moves *unapplied* money onto
*still-open* days, so a second run finds nothing. A plan-scoped advisory lock
stops two concurrent collections claiming the same day, without blocking other
agents.

**`rent_sweep_unapplied_collections()`** runs the same allocator across every
plan holding surplus that has somewhere to put it — intended for straight after
the daily pin, so pre-paid money lands on the day it just created.

### Reversals stay honest

Reversing a collection does not delete its row; it only appends
`[REVERSED: reason]` to the notes. Without handling, reversed money would keep
showing days as covered. A trigger on `agent_collections` watches for that notes
change and releases the days that collection had settled. Detecting the notes
change avoids editing a money-moving RPC.

### Wired into the one write path

`agent_allocate_tenant_payment` is the only RPC that writes a collection, so the
allocator hooks in there, immediately after the existing expected/shortfall
stamping.

The call is **deliberately non-fatal.** Attribution is derived and self-healing —
the sweeper reapplies anything left unapplied — so a fault in it must never block
a collection or unwind money that has already moved. It warns and carries on.
Everything else in that function is unchanged, including the
`REPAYMENT_NOT_STARTED` guard added earlier today.

---

## Traceability

Every settlement row names both the collection that paid and the day it paid,
so money is traceable in either direction: from a receipt to the days it closed,
or from an open day to the payments against it.

**`rent_arrears_read_authorized()`** is the staff gate. It reuses the existing
`agent_ops_report_authorized()` and then adds the roles that gate does not
cover. This mattered: `is_ops_role()`, which the existing gate calls internally,
matches only `manager`, `super_admin`, `coo` and `operations` — so **`tenant_ops`
would have been locked out**. `tenant_ops`, `financial_ops`, `landlord_ops` and
`partner_ops` are therefore named explicitly. CFO, agent ops and the other
executive roles were already covered.

Two read functions, each **one round trip with the aggregation done server-side**:

- **`rent_plan_day_ledger(rent_request_id)`** — one tenant, day by day, plus the
  summary and any unapplied money. Readable by staff or the owning/assigned
  agent.
- **`agent_arrears_overview(agent_id)`** — an agent's whole book: totals plus a
  per-tenant list of days behind, arrears and what is still due today. Agents
  read their own; staff read any.

---

## No backfill

`rent_arrears_go_live()` returns **2026-09-10** and is the single floor every
view and function derives from. Days before it are never open, so nothing
historical enters the queue:

- the **12,874,625** of shortfall already recorded on past receipts stays out
- the **427 post-cycle plans owing 129,037,935** stay out

Confirmed after applying: the day ledger, the settlement table, the arrears
summary and the unapplied view all return **zero rows**. The queue starts empty.

**Why the floor is tomorrow and not today.** It was 14:22 EAT when this shipped,
and collections had already been recorded today. A floor of 2026-09-09 would have
left day one only partly attributed unless those earlier collections were written
retroactively — which is exactly the backfill being avoided. A floor at the start
of a day that has not begun gives a first day complete from its first minute, and
clean daily aggregation from the outset.

---

## Verification

**The allocation arithmetic was proved against real production data before
anything was applied**, as a read-only rehearsal over today's actual pin and
collections:

| Check | Result |
| --- | --- |
| Plans exercised | 47 |
| Plans where allocated ≠ `LEAST(funds, need)` | **0** |
| Total allocated vs expected | 1,474,389 = 1,474,389 |
| Days over-settled | **0** |
| Collections over-applied | **0** |
| Non-positive rows produced | **0** |

**The view logic was proved the same way**, with the floor moved to today:

| Check | Result |
| --- | --- |
| Day-ledger rows vs pin rows for today | 226 = 226 |
| Day-ledger expected vs pin expected | 5,258,095 = 5,258,095 |
| Plans summarised | 226 |
| Plans failing to resolve to an agent | **0** |

After applying: 1 table, 3 views, 7 functions and 1 trigger present; the
collection path confirmed calling the allocator; all seven guards pass; no
prohibited terminology.

**One thing that cannot be exercised until tomorrow.** Because the floor is
2026-09-10, there is no data in scope yet, so the allocator has not yet run
against a live collection — only against the read-only rehearsal above. The first
real attribution happens on the first collection after midnight EAT.

---

## Known gaps, deliberately left for later

1. **The sweeper is not scheduled.** `rent_sweep_unapplied_collections()` exists
   and works but is not yet attached to the cron that runs the 00:05 pin. Until
   it is, pre-paid surplus is applied on the plan's *next* collection rather
   than the moment its day is pinned. Nothing is lost either way — this only
   affects how quickly a pre-payment shows as settling a day.
2. **`39976d4a`** (weekly, 7-day term, start date equal to its funding day) has
   no pinned day at all, so it can never appear in this queue despite owing
   1,700,000. Still awaiting a decision; the options are in
   `arrears-carry-forward-settlement-order.md`.
3. **Phase 2 and 3 are untouched.** The collect screen still asks for today's
   amount only, there is no agent-facing arrears view yet, and the eligibility
   gate still credits raw cash.

---

## What phase 2 needs, per the agreed scope

- The collect screen keeps showing **only today's amount** — no change to
  `agent_expected_collection`, which already reads today's pinned instalment.
- The behind-days information appears **in the existing confirmation dialog**
  when the agent presses pay: this tenant is behind *N* days and *X*, so part of
  this payment will be applied to the older unpaid days.
- The agent-facing arrears view reads `agent_arrears_overview()` and
  `rent_plan_day_ledger()`; both are live and need no further backend work.

Phase 3 remains the eligibility-gate change, still blocked on the 19-agent
auto-pass question.

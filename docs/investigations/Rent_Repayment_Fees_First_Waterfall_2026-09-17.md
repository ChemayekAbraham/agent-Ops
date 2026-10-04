# Rent repayment: fees-first vs pro-rata split — findings and proposal

Date: 2026-09-17. Read-only report. No code, SQL or data was changed.

---

## 1. What happens today (live, verified)

A Rent Plan is priced by one locked formula:

```
Total repayable = Rent + Access fee + Registration fee
Access fee      = Rent × (1.33^(days/30) − 1)
Registration    = 10,000 (rent ≤ 200,000) else 20,000
Daily amount    = ceil(Total repayable / days)
```

Every repayment (agent collection or tenant self-pay) is already decomposed in the
background. The engine is live, not dormant:

- `instalment_allocations` — **937 rows** (one row per instalment).
- Scope gate `is_treasury_waterfall_scope()` — plans funded on/after
  **2026-09-08** with fees > 0. **195** of the **785** open plans qualify; the rest
  stay on the old undecomposed model forever.
- `post_instalment_waterfall()` writes the row and posts the ledger legs
  (`treasury_allocated`, `agent_commission_accrued`, `treasury_net_revenue`).

### The split rule in force is **pro-rata**, not fees-first

`compute_instalment_allocation()` divides each instalment by the plan's own weights:

```
principal share    = amount × Rent      / Total repayable
access share       = amount × AccessFee / Total repayable
registration share = amount × RegFee    / Total repayable
```

with largest-remainder rounding, and a hard invariant that the three parts foot
exactly to the instalment. It is computed on **cumulative** amounts, so it is
self-correcting across partial payments and reversals.

Worked example — rent 1,000,000 over 30 days (access 330,000, registration 20,000,
total 1,350,000, daily 45,000). Each 45,000 instalment is split today as:

| Component | Per instalment |
|---|---|
| Principal (landlord float returning) | 33,333 |
| Access fee | 11,000 |
| Registration fee | 667 |

So the fees trickle in across the whole term. The CFO can never say "fees are now
fully covered, everything from here is landlord float coming back".

---

## 2. What you are asking for

Fees-first ordering, from today onwards, once the landlord has actually been paid:

1. **Stage 1 — Registration:** Access fee + Registration fee are covered first.
   In the example that is 350,000, i.e. the first ~7.8 instalments of 45,000.
2. **Stage 2 — Landlord float recovery:** every shilling after that repays the
   1,000,000 the company released as landlord float.

Nothing changes for the tenant or the agent: same total, same daily amount, same
schedule and arrears. Only the internal attribution order changes.

---

## 3. Why this is a small change

**No new tables.** `instalment_allocations` already carries exactly the three
component columns needed, plus commission, partner attribution and platform net.
The change is confined to the ordering rule inside
`compute_instalment_allocation()` — the one function that decides the split.

Proposed ordering logic (cumulative, so partials and reversals stay correct):

```
cum        = all instalments so far + this one
feesTotal  = AccessFee + RegistrationFee
feesPaid   = min(cum, feesTotal)
principal  = max(0, cum − feesTotal)
-- inside feesPaid, split registration first, then access
regPaid    = min(feesPaid, RegistrationFee)
accessPaid = feesPaid − regPaid
```

Then this instalment's components are the cumulative figures minus what earlier
rows already recorded — exactly the delta mechanism `allocate_instalment()`
already uses. The footing invariant is unchanged.

Because everything is derived from cumulative totals, no backfill is needed and no
historical row has to be rewritten.

### Scope boundary to decide

Three options, in increasing disruption:

- **A. New plans only** — apply fees-first to plans funded from the switch date.
  Cleanest: each plan keeps one ordering rule for its whole life. Recommended.
- **B. All post-2026-09-08 plans** — the 195 in-scope plans switch mid-term. Their
  earlier rows stay pro-rata; the next instalment absorbs a catch-up jump (fees
  accelerate, principal recovery pauses). Legal but produces one lumpy instalment
  per plan.
- **C. Everything** — not possible for the 590 pre-go-live plans: their past
  payments were never decomposed, so any split would be invented, not accounted.

---

## 4. Landlord-paid precondition

You asked that this only begin once the landlord has actually been paid. That gate
now exists on the collection side: collections are blocked (in the app and in the
database) while an `agent_landlord_float_allocations` row still shows
`remaining_amount > 0`. So in practice no instalment can be allocated before the
landlord is paid, and the fees-first clock starts on the first real collection.

If you want it belt-and-braces, `post_instalment_waterfall()` could also refuse to
allocate while the landlord is unpaid, rather than relying on the collection gate.

---

## 5. What the CFO would see afterwards

From the existing single table, with no new storage:

- **Registration recovered / outstanding per plan** — sum of access +
  registration components vs the priced fees.
- **A clear stage flag** — "Registration stage" vs "Float recovery stage", derived
  as `cumulative paid ≥ AccessFee + RegistrationFee`.
- **Landlord float outstanding** — priced rent minus principal components to date.
  This is the number that currently cannot be stated cleanly.
- Portfolio view: how much of today's collections was fee recovery and how much
  was float coming back.

---

## 6. Consequences to accept before switching

1. **Revenue recognition accelerates.** Fees land in the first ~26% of the term
   instead of spreading evenly. Reported platform revenue per month rises early
   and falls later, with no change to cash.
2. **Agent commission timing.** Commission is 10% of cumulative collected, so its
   total is unaffected — but the ledger currently funds it out of the access-fee
   leg. Under fees-first the early instalments carry more fee, so the early
   `treasury_net_revenue` legs get larger and later ones smaller (possibly
   contra-revenue). Worth confirming the CFO wants that shape.
3. **Partner attribution** (15% of principal, memo only) is driven off cumulative
   access fee, so it would front-load too. It is attribution-only, never payable,
   so this is presentational.
4. **Comparability.** Plans on each side of the switch date will not be comparable
   month-on-month. A per-plan marker of which rule applied is worth carrying.
5. **Default exposure reads worse early, better late.** Under fees-first, an early
   default means almost none of the landlord float has been recovered. That is
   the honest picture, but it will move the exposure numbers.

---

## 7. Recommendation

Adopt fees-first with **option A** (new plans from the switch date), implemented as
an ordering change inside `compute_instalment_allocation()` plus a per-plan rule
marker, and keep the landlord-paid gate as the trigger. No new tables, no backfill,
no change to what the tenant or agent sees.

Awaiting your decision on: the switch date, whether the 195 in-scope plans switch
mid-term, and whether registration or access should be covered first inside stage 1.

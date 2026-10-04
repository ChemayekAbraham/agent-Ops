# How the Rent Repayment Engine Worked (Legacy Path, pre-8 Sep 2026)

Status: explanatory document, read-only research. No behaviour is changed by this file.
Audience: anyone who wants to understand what the system actually did with a tenant's
daily repayment before the Treasury waterfall (Phase 2) went live.

---

## 1. The pricing formula — what a tenant owes

Before any repayment exists, the plan itself is priced by a single database formula:

```
Total Repayment = (Rent × 1.33^n) + Registration Fee   where n = days/30
Registration Fee = 10,000 if Rent ≤ 200,000 else 20,000
Daily Payment    = ceil(Total Repayment / Days)
```

- `compute_rent_repayment(rent, days)` (IMMUTABLE DB function) is the source of truth.
  It returns `access_fee`, `request_fee` (registration), `total_repayment`,
  `daily_repayment`.
- A BEFORE INSERT/UPDATE trigger `trg_enforce_rent_request_formula` on `rent_requests`
  **silently overwrites** the four fee fields with these canonical values. Whatever the
  client sent is ignored.

So every plan has three priced components baked into one number:

| Component | Meaning | Who it economically belongs to |
|---|---|---|
| Principal (rent) | The landlord's money | Landlord (via agent/landlord float) |
| Access fee | Rent × (1.33^n − 1) | Platform |
| Registration fee | 10,000 / 20,000 flat | Platform |

**Worked example** (the approved reference): rent 1,000,000 + access 330,000 +
registration 20,000 = **total repayable 1,350,000** over 30 days → **45,000/day**.

## 2. How a payment enters the system

Three channels existed, all converging on the same repayment-recording RPC:

1. **Tenant self-pay (MoMo / wallet)** — the `tenant-pay-rent` edge function.
2. **Agent cash collection** — agent collects physical cash, allocates it via
   `agent_allocate_tenant_payment` from their float; an `agent_collections` row is
   inserted (this is what "Today's capacity" dashboards read).
3. **Deposit-driven payment** — approved deposits flowing into repayment recording.

The `tenant-pay-rent` edge function made **three separate RPC round-trips**, each its
own database transaction (this gap pre-dates Phase 2):

| Step | Call | What it did |
|---|---|---|
| T1 | `create_ledger_transaction` | Posted the double-entry wallet + platform legs |
| T2 | `record_rent_request_repayment` (→ v2) | Recorded the repayment against the plan |
| T3 | `credit_agent_rent_commission` | Paid the agent's commission |

Because these were independent transactions, a failure between them could leave a
partially-recorded payment — a known, pre-existing exposure the code reported as
`"partial": true`.

## 3. What the legacy engine did with the money — the key point

**The legacy path did NOT decompose an instalment into principal / access fee /
registration fee.** This is the single most important thing to understand.

When a tenant paid, say, 45,000:

1. **The plan's outstanding balance was simply reduced by the amount paid.**
   `amount_repaid` on the rent request went up; nothing recorded *which* component of
   the 45,000 had just been covered. There was no allocation table, no per-instalment
   split, no ordering rule (fees-first vs principal-first vs pro-rata). The plan was
   treated as one undifferentiated pot of "total repayable".

2. **The agent earned 10% commission on whatever was collected.**
   Agent commission = 10% × `total_repayment` collected, paid as repayments came in —
   `credit_agent_rent_commission` posted it straight to the agent's withdrawable
   wallet bucket. On the worked example that's 4,500 per 45,000 instalment, 135,000
   over the full plan.

3. **The ledger posted balanced double-entry legs** (wallet `cash_in` / platform
   `cash_out` counterparts) so money movement balanced, but the legs were *not*
   categorised into "this much was access fee, this much was rent".

4. **Fees were recognised elsewhere, loosely.** Fee revenue on these plans was tracked
   only in a separate `fee_revenue_ledger`, never decomposed inside the general
   ledger per payment.

### What this means in plain terms

- There was **no rule** saying "the platform takes its access fee + registration fee
  first, then the tenant starts repaying actual rent". That fees-first model was never
  implemented.
- There was also **no pro-rata split** (the Phase 2 model: each instalment is
  33,333 principal / 667 registration / 11,000 access for the worked example).
- The legacy model was effectively **"one bucket, commission on top"**: reduce the
  outstanding total, pay the agent 10%, and keep platform fees as a side-record
  rather than a per-payment ledger fact.

## 4. Wallets and buckets

Money landed in the platform's 3-bucket wallet model:

- `withdrawable_balance` — what a user can actually withdraw (commissions go here).
- `float_balance` — company money an agent holds (used to fund tenants and to absorb
  cash collections); never withdrawable.
- `advance_balance` — a liability bucket auto-recovered from incoming earnings.

All bucket changes went through the sole-writer `apply_wallet_movement`, driven by
ledger triggers — no direct wallet edits anywhere in the path.

## 5. Why Phase 2 was designed (and why legacy stays legacy)

The Sep 2026 financial-modeling work defined the **Treasury waterfall**: each
instalment is split pro-rata into principal → landlord float economics, registration →
Platform Treasury, access → Platform Treasury; then Treasury pays the 10% agent
commission and the remainder is recognised as Platform Net Revenue. Partner reward
(15% of principal) is **attribution-only** (memo), never a payable.

That engine (`record_rent_request_repayment_v2`, `post_instalment_waterfall`,
`allocate_instalment`, `instalment_allocations`) is built and live in the database but
**dormant** at the time of writing:

- `instalment_allocations` has **0 rows**.
- Go-live boundary `treasury_waterfall_go_live() = 2026-09-08 00:00:00+00`.
- All ~688 open plans were funded **before** the boundary → they are explicitly
  **legacy scope (Option B)** and keep the behaviour described in §3 forever.
- 20 funded rows with NULL `funded_at` are forced legacy too (NULL ≥ boundary is NULL,
  so the scope function excludes them deliberately).

### Option A (backfilling the 688 legacy plans) remains blocked

To bring legacy plans into the Treasury model, the system would need to know how much
of each *past* payment was fee vs principal. Those payments were never decomposed, so
any reconstruction would be inference, not accounting. Measured exposure at audit time:
688 open plans, UGX 260,580,341 outstanding (189.7M principal, 69.6M access, 6.9M
registration), implying ~UGX 76.4M of Treasury allocation. Until the business accepts
a constructed split, Option A stays off the table and Option B governs.

## 6. One-paragraph summary

Under the engine that was actually running, a tenant's repayment was **not** split
fees-first and was **not** split pro-rata either: the payment simply reduced the
plan's outstanding total as one undifferentiated amount, the agent instantly earned
10% of whatever was collected into their withdrawable wallet, the ledger posted
balanced but component-blind legs, and platform fees lived in a separate side ledger.
The pro-rata Treasury waterfall that *does* decompose every instalment (principal +
10% agent commission + 15% attribution-only partner reward, fees to Treasury) exists
in the database but only activates for plans funded on or after 8 Sep 2026 — every
plan funded before that date runs on the legacy model described here.

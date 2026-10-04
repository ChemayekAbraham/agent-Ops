# Landlord Flow → Platform Treasury: approved worked example and go-live scope

Status: **prepared, not deployed.** Production behaviour is unchanged.

## Approved UGX 45,000 instalment example (authoritative)

Reference request `3f505690-8f92-4f36-873f-ac4dface5ca0` — principal 1,000,000,
access fee 330,000, registration fee 20,000, total repayment 1,350,000, 30 days,
daily instalment 45,000.

### Step 1 — the instalment splits three ways (all are real ledger amounts)

| Component | Amount | Destination | Basis |
|---|---:|---|---|
| Principal | **33,333** | Landlord Float economics | 1,000,000 / 1,350,000 of the instalment |
| Registration fee | **667** | Platform Treasury | 20,000 / 1,350,000 |
| Access fee | **11,000** | Platform Treasury | 330,000 / 1,350,000 |
| **Instalment total** | **45,000** | | 33,333 + 667 + 11,000 |

**Platform Treasury = Registration Fee + Access Fee = 11,667.** Principal is never
Treasury.

### Step 2 — what the ledger actually posts

| Leg | Account | Amount |
|---|---|---:|
| Treasury drawn down | DR **L7** | 11,667 |
| Agent Commission payable | CR **L5** | 4,500 |
| **Platform Net Revenue** | CR **R1** | **7,167** |

`7,167 = 11,667 Treasury − 4,500 Agent Commission`. **This is the only revenue
figure. Nothing else is recognised.**

### Step 3 — memo attributions inside the Access Fee (NOT ledger amounts)

These three sum to the Access Fee and exist only in `instalment_allocations` for
economic analysis. **Only the Agent Commission creates a payable.**

| Attribution | Amount | Creates a payable? |
|---|---:|---|
| Partner Reward allocation | **5,000** | **No** — allocation-only under BD-2; borne through portfolio ROI expense (X2). No L3 entry |
| Agent Commission | **4,500** | **Yes** — L5 |
| **Platform Net Revenue (within Access Fee)** | **1,500** | No — memo sub-figure |
| **Access fee total** | **11,000** | |

> ⚠️ **Do not read the 1,500 as platform earnings.** The platform recognises
> **7,167** for this instalment. The 1,500 is only the Access Fee remainder
> *after notionally attributing* the partner reward — and that partner attribution
> is not deducted from revenue here, because it creates no payable. The
> reconciliation is:
>
> `R1 7,167 = 1,500 memo remainder + 5,000 partner attribution + 667 registration fee`
>
> Treating 1,500 as recognised revenue understates it by 79%.

### Terminology

The term **"Platform Residual" is retired** — it implied a leftover plug with no
defined meaning. The correct terms are:

- **Platform Treasury** — Registration Fee + Access Fee (the recognised Treasury fees)
- **Platform Net Revenue** — what is actually credited to R1 (Treasury less Agent Commission)

### Correction to earlier test documentation

An earlier test description listed *Partner = 4,500, Agent = 1,500, Platform =
5,000*. **That is a transposition error in the test description, not a business
rule change.** The three labels were permuted; the total (11,000) was correct.

It is self-contradicting: the same specification states the full plan yields
agent commission 135,000 over 30 instalments, which is 4,500 per instalment, and
partner allocation 150,000, which is 5,000 per instalment. Agent commission at
10% of a 45,000 instalment is 4,500 by definition — 1,500 would imply a 3.33%
rate.

The table above governs. **The 15% Partner Reward allocation-only rule (BD-2) and
the 10% Agent Commission rule are unchanged.**

## Full-plan reconciliation (verified, rolled back)

30 instalments of 45,000 reconcile exactly:

**Ledger amounts**

| | Sum of instalments | Priced |
|---|---:|---:|
| Principal → Landlord Float | 1,000,000 | 1,000,000 |
| Registration → Treasury | 20,000 | 20,000 |
| Access → Treasury | 330,000 | 330,000 |
| **Platform Treasury gross** | **350,000** | registration + access |
| Agent Commission → **L5** | 135,000 | 10% × 1,350,000 |
| **Platform Net Revenue → R1** | **215,000** | 350,000 − 135,000 |

**Memo attributions inside the 330,000 Access Fee** (not ledger amounts):

| Attribution | Amount | Creates a payable? |
|---|---:|---|
| Partner Reward allocation | 150,000 | **No** — 15% × principal, allocation-only (BD-2) |
| Agent Commission | 135,000 | Yes — L5 |
| Platform Net Revenue (within Access Fee) | 45,000 | No — memo sub-figure |

Reconciliation: `R1 215,000 = 45,000 memo remainder + 150,000 partner attribution
+ 20,000 registration fee`.

## Go-live scope — Option B

**Authoritative funding field:** `rent_requests.funded_at`, set by
`fund-agent-landlord-float` when status becomes `funded`.

**Go-live boundary:** `treasury_waterfall_go_live()` = `2026-09-08 00:00:00+00`,
matching `rent_pricing_floor_effective_from()` so the BD-4 pricing floor and the
Treasury economics begin together. This matters: the floor is what keeps Treasury
non-negative, so a request priced below it should not enter the waterfall.

| Population | Requests | Treatment |
|---|---:|---|
| Open plans funded before go-live | **688** | Legacy path. Not blocked, not backfilled. |
| Funded-status rows with NULL `funded_at` | **20** | Forced legacy by explicit NULL handling |
| Pipeline awaiting funding | **2** | Enter the new path once funded |
| Open plans currently in scope | **0** | — |

`is_treasury_waterfall_scope()` treats a NULL `funded_at` as legacy explicitly,
because 20 rows carry a funded status with no funding timestamp and `NULL >= x`
evaluates to NULL rather than false.

## Option A backfill plan — READ-ONLY, NOT EXECUTED

Bringing the 688 legacy plans into the Treasury model would require, per request:

1. Recognise the **outstanding** (not original) fee economics:
   `DR A3 fee_receivable_created / CR L7 treasury_fee_recognised`, sized to the
   unpaid Access + Registration fee.
2. Decide the treatment of fees **already collected** on those plans. Payments to
   date were never decomposed, so there is no allocation history — reconstructing
   it would be inference, not accounting. Those instalments are legacy and
   unreconstructable by design.
3. Seed `instalment_allocations` with an opening cumulative position so the
   cumulative true-up does not re-allocate amounts already paid.

Measured exposure:

| Measure | Amount |
|---|---:|
| Open plans | 688 |
| Outstanding repayment | 260,580,341 |
| — outstanding principal | 189,731,752 |
| — outstanding access fee | 69,557,453 |
| — outstanding registration fee | 6,859,029 |
| Treasury allocation implied | **76,416,482** |
| Estimated partner allocation | 47,629,059 |
| Estimated agent commission | 38,296,626 |

**Open question that blocks Option A:** step 2 has no evidence-based answer. Fees
already collected on legacy plans were recognised only in `fee_revenue_ledger`,
never in the general ledger, so any split between "already earned" and "still to
earn" would be constructed rather than derived. Option A should not proceed until
that is settled as a business decision.

Option B avoids the question entirely by leaving legacy plans on their existing
path.

## Transaction-boundary audit (`tenant-pay-rent`)

`tenant-pay-rent` makes three separate RPC round-trips, **each its own database
transaction**:

| Line | Call | Transaction |
|---|---|---|
| 124 | `create_ledger_transaction` — wallet + platform legs | **T1** |
| 167 | `record_rent_request_repayment` → becomes `..._v2` | **T2** |
| 181 | `credit_agent_rent_commission` | **T3** |

The function already reports `"partial: true"` at line 175 when T2 fails after T1
succeeded. **This gap is pre-existing and long predates Phase 2.**

**What the Phase 2 change does:** folds the repayment, the L7 sequencing
assertion, the allocation spine and the Treasury component postings into **T2**,
so those four either all commit or all roll back. Previously the waterfall would
have been a fourth round-trip (T4) and could have left a payment with no
allocation.

**What remains open:** T1 (ledger legs) and T3 (commission) are still separate
from T2.

**Does Phase 2 make it worse? No.** It strictly reduces the number of independent
failure boundaries in the repayment path, from a would-be four down to three, and
adds no new cross-transaction dependency. The residual exposure is unchanged from
today's production behaviour.

**Closing it fully** would require folding all three calls into a single database
function — a broad refactor of a live money path. **Not performed; not approved.**

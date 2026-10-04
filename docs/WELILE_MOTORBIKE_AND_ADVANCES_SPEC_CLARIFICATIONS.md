# Welile Spiro Motorbike Program — Technical & Business Specification

> **Document Type**: Dedicated Business Model, Reducing-Balance Lease Calculations & System Specification  
> **Programme Name**: Welile Spiro Electric Motorbike Lease (Agent Asset Finance)  
> **Status**: Approved System Specification & Clarifications  
> **Currency**: UGX (Ugandan Shilling)  
> **Audience**: Agent Ops, COO, CFO, Engineering, Internal Audit  

---

## 1. Who is an "Active Agent" in the Spiro Bike Program?

For the **Welile Spiro Bike Program**, an **Active Agent** is defined as:

1. **Active Field Collector**: An agent actively assigned to collection zones with verified daily/weekly rent collection activity. Daily collections produce commission earnings that flow directly into their **Withdrawable Wallet**.
2. **Account in Good Standing**:
   - Verified profile with valid National Identification Number (NIN) and phone number.
   - Not suspended, terminated, or marked dormant by Agent Ops.
   - No open defaulted facilities or unserviced liabilities.
3. **Why Activity Matters for the Bike**: Welile provides the Spiro bike with **UGX 0 upfront deposit** and recovers the cost strictly from daily rent collection earnings. If an agent is inactive (not collecting rent), their wallet receives no inflows, and the bike lease cannot be recovered.

---

## 2. Under What Circumstances Can an Agent Post Another Bike Submission?

The platform enforces a strict lock:
$$\text{Max 1 In-Flight Bike Application per Agent}$$

An agent can only submit another bike application under the following exact circumstances:

1. **Previous Bike Lease Completed (Full Settlement)**: The agent has fully repaid their previous Spiro bike lease (`outstanding_balance == 0`, status = `'completed'`) and is now eligible to apply for an additional bike or upgrade.
2. **Previous Application Rejected**: A prior application was refused during Ops Verification, COO Approval, or CFO Review (with a recorded rejection reason), releasing the lock so the agent can submit a new application with adjusted terms (e.g., lower valuation, extended tenure).
3. **Application Cancelled by Agent / Ops**: The previous draft/submitted application was formally cancelled before disbursement.
4. **Why Concurrent In-Flight Submissions Are Refused**: If an application is currently `submitted`, `ops_approved`, `coo_approved`, or actively repaying (`approved`), any new submission attempt is blocked to prevent duplicate disbursements, double-debt loading, or ledger collisions.

---

## 3. Why Did the "15%" Exist & Why It Has Been Removed

### The Evolution:
1. **The Old/Prototype Model (15% Flat Deduction)** — ✅ **REMOVED**:  
   Originally, generic merchandise in Welile used a simplistic rule: `"sweep 15% of whatever wallet credit lands in the agent's account until paid off"`. The `BIKE_RECOVERY_RATE = 0.15` constant and every 0.15 fallback have been deleted from the codebase (Migration `0415`).
2. **The Active Spiro Model (28% Monthly Reducing Balance)** — ✅ **IMPLEMENTED**:  
   The commercial terms use a genuine **reducing-balance lease** hardcoded at **28% per month**:  
   - Principal is divided into equal monthly slices ($P = B/n$).  
   - A **fixed 28% monthly facility fee** is charged on the remaining balance at the start of each month.  
   - Each month's total obligation is divided by 30 to produce an **exact daily instalment ($d(m)$)** that drops every month.
   - The daily sweep now reads the correct month's instalment from `agent_bike_lease_schedules` instead of using a flat percentage.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MODEL TRANSITION SUMMARY                          │
├──────────────────────────────────────┬──────────────────────────────────────┤
│ ❌ OLD MODEL (15% Flat Rate)         │ ✅ ACTIVE SPIRO MODEL (28% Reducing) │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ • Flat 15% deduction on wallet credits│ • Fixed 28% monthly on opening bal   │
│ • No predictable repayment timeline  │ • Exact monthly & daily instalments  │
│ • Generic merchandise fallback       │ • Daily cap = instalment ÷ 30        │
│ • STATUS: **DELETED FROM CODEBASE**  │ • STATUS: **LIVE — CANONICAL MODEL** │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

> **Resolution**: The 15% flat rate has been fully removed. The sweep engine determines which month the agent is in (from `lease_activated_at`), looks up that month's instalment from `agent_bike_lease_schedules`, divides by 30 for the daily cap, and deducts `LEAST(outstanding, available_withdrawable, daily_cap)`.

---

## 4. Wallet Buckets & Daily Sweep Mechanics

### Which Wallet Bucket is Debited?
The Spiro bike recovery engine strictly debits the **`withdrawable_balance`** bucket in `wallets`.

- ✅ **`withdrawable_balance`** (Earned commissions & incentives): **The ONLY bucket debited.**
- ❌ **`float_balance`** (Company operational float for paying landlords): **NEVER touched.**
- ❌ **`advance_balance`** (Working capital liabilities): **NEVER touched.**

### What Happens If the Wallet is Below the Scheduled Daily Target or Empty?

The daily sweep amount is calculated via:
$$\text{Daily Sweep} = \min(\text{Outstanding Lease Balance},\; \text{Available Withdrawable Balance},\; \text{Daily Scheduled Cap})$$
### Breakdown of the formulae 
Daily Sweep = min(Outstanding Lease Balance, Available Withdrawable Balance, Daily Scheduled Cap)
- **Case 1: Available Withdrawable Balance < Daily Target**  
  *Example*: Daily target is UGX 71,467, but the agent's wallet has only UGX 20,000 in earned commissions.  
  *Result*: The sweep takes **UGX 20,000**. The lease balance decreases by UGX 20,000, leaving the wallet at UGX 0. No negative balance or overdraft is possible.
- **Case 2: Wallet is Empty (UGX 0)**  
  *Result*: The sweep takes **UGX 0**. The day is skipped cleanly. No penalty fee is added, no interest compounds, and no overdraft occurs.

---

## 5. Commercial Rationale: Why Charge 28% Monthly Reducing Balance on Spiro Bikes?

1. **Zero Upfront Deposit (100% Financed Asset)**: The agent acquires a brand-new electric motorbike without paying any cash upfront.
2. **Unsecured Field Asset Risk**: Welile bears the full capital risk. If an agent stops collecting or relocates, recovery relies entirely on asset repossession.
3. **Reducing Balance is Fairer Than Flat Interest**: Under reducing balance, 28% is charged only on the *unpaid principal*. As the agent repays, the monthly fee drops dramatically (e.g. Month 1 fee = UGX 1,344,000 $\rightarrow$ Month 6 fee = UGX 224,000).
4. **Self-Funding Productivity Asset**: A motorbike allows an agent to cover 3–5x more territory daily, increasing rent collection volume and commissions, which in turn easily covers the daily lease deduction.

---

## 6. Verification & Approval Roles: Removing `manager` from the Allowlist

To enforce strict **Four-Eyes Separation of Duties**, the role of `manager` should be removed from the bike approval chain:

```
┌─────────────────┐       ┌────────────────────┐       ┌────────────────────┐       ┌────────────────────┐
│  STAGE 1: AGENT │       │ STAGE 2: AGENT OPS │       │   STAGE 3: COO     │       │   STAGE 4: CFO     │
├─────────────────┤       ├────────────────────┤       ├────────────────────┤       ├────────────────────┤
│ • Submits       │ ────▶ │ • Field & identity │ ────▶ │ • Approves commercial│ ───▶ │ • Posts ledger     │
│   application   │       │   verification     │       │   terms (valuation,│       │   disbursement     │
│ • Chooses term  │       │ • Checks route &   │       │   term, rate)      │       │ • Activates live   │
│   (1-24 months) │       │   performance      │       │ • Sets final price │       │   recovery plan    │
│                 │       │                    │       │                    │       │                    │
│ Self-Service    │       │ Role: `agent_ops`  │       │ Role: `coo` ONLY   │       │ Role: `cfo` ONLY   │
│ (Agent Only)    │       │ ONLY               │       │                    │       │ (Registered Auth)  │
└─────────────────┘       └────────────────────┘       └────────────────────┘       └────────────────────┘
```

- **Why remove `manager`?** A general "manager" role allows operational personnel to potentially bypass executive commercial review (COO) or treasury control (CFO). Only the designated C-level roles should commit company capital.

---

## 7. Strategic Input on Section 10 (Known Gaps & Open Decisions)

### 10.1 Quoted Schedule vs. Flat Daily Sweep
- **The Issue**: The quote shows a reducing monthly schedule, but the automated sweep used a flat 15% rate.
- ✅ **IMPLEMENTED** (Migration `0415_bike_lease_fixed_28pct_reducing_balance.sql`):
  - 28% monthly reducing-balance is hardcoded for all bike leases — no per-lease rate setting.
  - The sweep determines the agent's current month from `lease_activated_at`, looks up the instalment from `agent_bike_lease_schedules`, divides by 30, and deducts that fixed daily cap.
  - The old `BIKE_RECOVERY_RATE = 0.15` constant and every 0.15 fallback have been deleted.
  - All 8 existing lease schedules regenerated at 28%.

### 10.2 Arrears & Inactivity Policy
- **The Issue**: When an agent earns 0 UGX, the sweep simply skips with no escalation or arrears flagging.
- 🔧 **SENT TO LOVABLE** — Two-sided dormancy detection for bike leases only:
  - **Agent Ops Dashboard**: "Dormant Bike Leases" alert panel (red/amber) showing agent name, bike model, days since last deduction, and outstanding balance for any active lease with no deduction in 7+ days.
  - **Agent Dashboard**: Friendly reminder banner — "Your bike lease payments have been paused for 7 days — collect rent to keep your repayment on track" — with outstanding balance and days remaining.
  - **Agent Notification**: One-time `bike_lease_reminder` notification inserted into `notifications` table per dormancy period (not repeated daily). Tone is encouraging, not threatening.
  - If inactive for **14 days**, temporarily suspend rent float issuance until field officer conducts an in-person audit of the bike and agent (future phase).

### 10.3 Bike Ownership, Security & Logbook Custody
- ✅ **IMPLEMENTED**:
  - `agent_bike_leases.logbook_status` tracks custody across 5 states: `pending_registration` → `held_by_welile` → `held_by_supplier` → `with_agent` → `released`.
  - **Bike Asset Details Dialog** (`BikeAssetDetailsDialog.tsx`) allows Ops to record plate number, chassis number, battery serial, GPS tracker ID, and logbook custody — all changes audit-logged with old and new values.
  - **Certificate of Full Settlement PDF** auto-generates with legal discharge clause and COO/CFO signatories when `outstanding_balance == 0`.
  - Agent-facing **Terms & Conditions** with mandatory acceptance checkbox on the order dialog.

### 10.4 Deprecating Legacy Direct Sales Path
- ✅ **IMPLEMENTED**: All new bike applications create records exclusively in `agent_bike_leases` via the `agent_order_spiro_bike_lease` RPC.

### 10.5 Dedicated Spiro Bike Table Architecture
- ✅ **IMPLEMENTED** (Migration `0406_bike_leases_dedicated_tables.sql`):
  - **`agent_bike_leases`**: Dedicated table with physical asset columns, approval audit fields (including **approver names** — Migration `0417`), and settlement tracking.
  - **`agent_bike_lease_schedules`**: Month-by-month reducing-balance rows at fixed 28%, versioned for audit.
  - All 8 existing bike applications backfilled. No `merchandise_sales` rows dropped.
  - **Bike cost price** now reads from `merchandise_catalog.unit_cost` via `useBikeCatalogCosts.ts` — no longer reverse-engineered from the interest formula.

### 10.6 Approver Identity Tracking
- ✅ **IMPLEMENTED** (Migration `0417_bike_lease_approver_names.sql`):
  - Each approval stage records the approver's user ID and full name: `ops_approved_by`, `coo_approved_by`, `cfo_approved_by`.
  - Displayed in the lease detail dialog under Application History (e.g. "Agent Ops verified by Jane Nakato").

### 10.7 Applicant Data Drilldowns
- ✅ **IMPLEMENTED**:
  - The Applicant Standing & Team stat cards in the lease detail dialog are **clickable** — each toggles an inline drilldown panel:
    - **Active Sub-Agents** → lists all sub-agents with name, status, and date added.
    - **Active Tenants** → lists funded/repaying tenants with daily repayment, amount repaid, and rent amount.
    - **30d Collections** → lists last 30 days of collections with tenant name, amount, date, and payment method.
  - Cards show hover cursor, subtle highlight, and active state border when expanded.

### 10.8 Repayment Schedule Calculation
- ✅ **FIXED**:
  - The Repayment Breakdown in the detail dialog now calculates the 28% reducing-balance schedule on the **valuation amount** (the actual principal the agent repays), not a reverse-engineered cost price.
  - The old formula `spiroLeaseSchedule(term, valuation / (1 + feePct/100))` has been replaced with `spiroLeaseSchedule(term, valuation)`.
  - Bike Cost Price and Our Profit now read from `merchandise_catalog.unit_cost` via `useBikeCatalogCosts.ts`.

---

## 8. *Most Critical Part*: How the System Identifies a Spiro Bike Lease vs. Other Advances

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            WELILE SYSTEM ROUTING                            │
├──────────────────────────────────────┬──────────────────────────────────────┤
│        A. WORKING CAPITAL ADVANCE     │       B. SPIRO MOTORBIKE LEASE       │
│        (Table: `agent_advances`)     │       (Table: `agent_bike_leases`)    │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ • Pure cash float for rent ops       │ • Physical Spiro Electric Motorbike  │
│ • Straight credit to float balance   │ • Asset finance with reducing balance│
│ • No physical asset tracking         │ • 4-stage approval (Ops ➔ COO ➔ CFO) │
│ • Recovered via rent float flow      │ • Recovered via daily wallet sweep   │
│                                      │ • Fixed 28% monthly reducing-balance │
│                                      │ • Physical asset tracking (chassis,  │
│                                      │   battery, GPS, plate, logbook)      │
│                                      │ • Approver names recorded per stage  │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

### Identification Criteria for a Spiro Bike in `agent_bike_leases`:
1. **Dedicated Table**: All bike leases reside in `agent_bike_leases` (migrated from `merchandise_sales`).
2. **Physical Asset Fields**: `plate_number`, `chassis_number`, `battery_serial`, `gps_tracker_id`, `logbook_status`.
3. **Lease Configuration**: `lease_term_months` (1–24), fixed 28% `monthly_rate_pct`, `valuation_amount`, `amount_outstanding`.
4. **Reducing-Balance Schedule**: Pre-calculated month-by-month rows in `agent_bike_lease_schedules`.
5. **Supplier Cost**: Read from `merchandise_catalog.unit_cost` — profit = valuation − supplier cost.
6. **Approval Flow** (with approver names recorded):
   $$\text{submitted} \longrightarrow \text{ops\_approved} \longrightarrow \text{coo\_approved} \longrightarrow \text{approved (disbursed)} \longrightarrow \text{settled}$$

---

## 9. Comprehensive Worked Example on a Live Spiro Bike Account

### Live Account Profile
- **Agent Name**: Ronald Musana (Agent ID: `agt_kampala_0442`)
- **Asset**: Spiro Commuter Electric Motorbike
- **Valuation (Base Price $B$)**: **UGX 4,800,000**
- **Lease Term ($n$)**: **6 Months**
- **Monthly Facility Fee Rate ($r$)**: **28% (0.28)** per month on reducing balance
- **Monthly Principal Slice ($P$)**: $\frac{\text{UGX } 4,800,000}{6} = \text{\bf UGX 800,000 / month}$

---

### Step 1: Complete Reducing-Balance Schedule

$$\text{Fee for Month } m: F(m) = \text{Opening Balance } O(m) \times 0.28$$
$$\text{Total Due for Month } m: T(m) = P(m) + F(m)$$
$$\text{Daily Target}: d(m) = \left\lceil \frac{T(m)}{30} \right\rceil$$

| Month ($m$) | Opening Balance | Principal ($P$) | Fee ($28\% \times \text{Opening}$) | Total Due ($T$) | Daily Target (30d) | Closing Balance |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Month 1** | UGX 4,800,000 | UGX 800,000 | UGX 1,344,000 | **UGX 2,144,000** | **UGX 71,467 / day** | UGX 4,000,000 |
| **Month 2** | UGX 4,000,000 | UGX 800,000 | UGX 1,120,000 | **UGX 1,920,000** | **UGX 64,000 / day** | UGX 3,200,000 |
| **Month 3** | UGX 3,200,000 | UGX 800,000 | UGX 896,000 | **UGX 1,696,000** | **UGX 56,534 / day** | UGX 2,400,000 |
| **Month 4** | UGX 2,400,000 | UGX 800,000 | UGX 672,000 | **UGX 1,472,000** | **UGX 49,067 / day** | UGX 1,600,000 |
| **Month 5** | UGX 1,600,000 | UGX 800,000 | UGX 448,000 | **UGX 1,248,000** | **UGX 41,600 / day** | UGX 800,000 |
| **Month 6** | UGX 800,000 | UGX 800,000 | UGX 224,000 | **UGX 1,024,000** | **UGX 34,134 / day** | **UGX 0** |
| **TOTALS** | — | **UGX 4,800,000** | **UGX 4,704,000** | **UGX 9,504,000** | — | **UGX 0** |

---

### Step 2: System Lifecycle & Ledger Entries

```
1. AGENT APPLIES
   • Screen: Merchandise Store ➔ Selects "Spiro Electric Bike" ➔ Chooses 6 Months.
   • Accepts mandatory Lease Terms & Conditions (logbook custody, daily sweeps, settlement).
   • Writes to `agent_bike_leases`:
     - status: 'submitted'
     - valuation_amount: 4,800,000
     - lease_term_months: 6
     - monthly_rate_pct: 28 (fixed)
     - logbook_status: 'pending_registration'
   • 28% reducing-balance schedule auto-generated in `agent_bike_lease_schedules`.

2. AGENT OPS VERIFICATION
   • Agent Ops reviews Ronald's collection history, sub-agents, active tenants, and NIN.
   • Ops records physical asset details via Bike Asset Details Dialog.
   • Action: Approves. Approver name recorded (e.g. "verified by Jane Nakato").
   • Status becomes: 'ops_approved'

3. COO COMMERCIAL APPROVAL
   • COO confirms final pricing: UGX 4.8M valuation, 6 months term.
   • Action: Approves. Approver name recorded.
   • Status becomes: 'coo_approved'

4. CFO DISBURSEMENT & ASSET ACTIVATION
   • CFO executes disbursement. Approver name recorded.
   • Status becomes: 'approved'
   • Ledger Transaction Posted:
     - DEBIT:  Account A16 (Agent Asset Finance Receivable)  UGX 4,800,000
     - CREDIT: Account L1  (Agent Withdrawable Wallet)       UGX 4,800,000
   • Daily sweep activated — reads Month 1's instalment (UGX 2,144,000 ÷ 30 = UGX 71,467/day).
   • Physical Delivery: Spiro bike and battery assigned to Ronald; logbook retained by Welile.
```

---

### Step 3: Real Daily Sweep Execution Log (Month 1)

| Day | Event / Earnings | Withdrawable Wallet Before | Sweep Formula: $\min(\text{Bal}, \text{Wallet}, \text{Cap})$ | Deducted | Wallet After | Outstanding Lease Balance | Deduction Logged |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Day 1** | Ronald collects 5 tenant rents, earning **UGX 100,000** commission. | UGX 100,000 | $\min(9,504,000,\; 100,000,\; 71,467)$ | **UGX 71,467** | UGX 28,533 *(Available for cashout)* | **UGX 9,432,533** | Row written in `merchandise_recovery_deductions` |
| **Day 2** | Ronald collects 2 tenant rents, earning **UGX 35,000** commission. | UGX 35,000 | $\min(9,432,533,\; 35,000,\; 71,467)$ | **UGX 35,000** | UGX 0 | **UGX 9,397,533** | Partial deduction row written |
| **Day 3** | Sunday / Rest day. **UGX 0** earned. | UGX 0 | $\min(9,397,533,\; 0,\; 71,467)$ | **UGX 0** | UGX 0 | **UGX 9,397,533** | Day skipped cleanly. Zero penalty. |
| **Day 4** | Ronald collects 8 tenant rents, earning **UGX 150,000** commission. | UGX 150,000 | $\min(9,397,533,\; 150,000,\; 71,467)$ | **UGX 71,467** | UGX 78,533 *(Available for cashout)* | **UGX 9,326,066** | Row written in `merchandise_recovery_deductions` |

---

### Step 4: Final Settlement & Completion
When cumulative deductions reach **UGX 9,504,000** (at or before the end of Month 6):
1. `agent_bike_leases.amount_outstanding` becomes **UGX 0**.
2. Lease status changes to `'settled'`, `certificate_issued_at` recorded automatically.
3. Automated system actions:
   - **Certificate of Full Settlement** PDF auto-generated with legal discharge clause and COO/CFO signatories — downloadable from the lease detail view.
   - `logbook_status` transitions to `'released'` — Welile Operations officially transfers the physical Spiro logbook and registration into Ronald Musana's name.
   - Ronald is unlocked and eligible to apply for another asset.

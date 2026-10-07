# Welile Spiro Electric Motorbike Program: Business Model Flow & Blueprint

> **Document Type**: Comprehensive Operational, Mathematical & Technical Blueprint (Spiro Electric Motorbike Leases)  
> **Target Audience**: Agent Operations, COO, CFO, Engineering, Internal Audit  
> **Currency**: UGX (Ugandan Shilling)  
> **Status**: Approved System Architecture & Operational Blueprint  

---

## 1. Executive Summary & Commercial Scope

Welile Technologies Limited provides active field rent collection agents with the **Spiro Electric Motorbike Lease Program (`agent_bike_leases`)**. This facility provides commercial electric motorcycles (Spiro Commando and Spiro ChapChap models) on a lease-to-own structure to dramatically expand field agent route coverage, speed up tenant onboarding, and increase daily rent collections.

Advances, smartphones, and consumer electronics are excluded from this core program documentation.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                             WELILE SPIRO BIKE PROGRAM FLYWHEEL                           │
└──────────────────────────────────────────────────────────────────────────────────────────┘
           │                                                               ▲
           ▼                                                               │
┌───────────────────────┐                                     ┌─────────────────────────┐
│ Spiro Motorbike Lease │ ──▶ 2x-3x Higher Field Mobility ──▶ │ More Tenants Onboarded  │
│ (UGX 0 Cash Deposit)  │                                     │ & Higher Rent Collected │
└───────────────────────┘                                     └─────────────────────────┘
           ▲                                                  └─────────────────────────┘
           │                                                               │
           │                                                               ▼
┌───────────────────────┐                                     ┌─────────────────────────┐
│ Automated Daily Sweep │ ◀── Generates Healthy Commissions ──│ Withdrawable Wallet     │
│ (28% Reducing Balance)│     (100% Retained by Agent)        │ Balance                 │
└───────────────────────┘                                     └─────────────────────────┘
```

---

## 2. Business Model Blueprint & Financial Engineering

### 2.1 Spiro Commercial Asset Structure

| Dimension | Spiro Commando | Spiro ChapChap |
| :--- | :--- | :--- |
| **Asset Category** | Heavy-duty commercial electric motorcycle | Urban commuter electric motorcycle |
| **Typical Valuation ($B$)** | UGX 4,800,000 – UGX 5,520,000 | UGX 4,200,000 – UGX 4,600,000 |
| **Upfront Cash Deposit** | **UGX 0 (100% financed)** | **UGX 0 (100% financed)** |
| **Eligible Lease Terms ($n$)** | 1 to 24 Months (Standard: 6 or 12 Months) | 1 to 24 Months (Standard: 6 or 12 Months) |
| **Pricing / Rate Model** | **Fixed 28.0% monthly reducing-balance** | **Fixed 28.0% monthly reducing-balance** |
| **Repayment Channel** | Automated daily sweep of **`withdrawable_balance`** via `pg_cron` | Automated daily sweep of **`withdrawable_balance`** via `pg_cron` |
| **Asset Identification** | Frame, Chassis, Battery Serial, GPS Tracker ID, Number Plate | Frame, Chassis, Battery Serial, GPS Tracker ID, Number Plate |
| **Logbook Custody** | Held by Welile until 100% fully settled | Held by Welile until 100% fully settled |

---

### 2.2 Mathematical Formulas: 28% Monthly Reducing Balance

For a lease with valuation (principal) $B$ and term $n$ months at monthly reducing rate $r = 28\%$:

1. **Equal Monthly Principal Slice**:
   $$P = \frac{B}{n}$$

2. **Opening Balance for Month $m$**:
   $$\text{Opening}(m) = B - (m - 1) \times P$$

3. **Monthly Facility Fee for Month $m$**:
   $$\text{Fee}(m) = \text{Opening}(m) \times 0.28$$

4. **Total Instalment Due for Month $m$**:
   $$T(m) = P + \text{Fee}(m)$$

5. **Daily Target Instalment (Flat 30-Day Month)**:
   $$d(m) = \left\lceil \frac{T(m)}{30} \right\rceil$$

6. **Daily Sweep Deduction Logic**:
   $$\text{Daily Sweep} = \min(\text{Outstanding Balance},\; \text{Withdrawable Balance},\; d(m))$$

---

## 3. End-to-End System Flowcharts

### 3.1 Origination, Verification, Approval & Activation Flow

```
┌─────────────────┐       ┌────────────────────┐       ┌────────────────────┐       ┌────────────────────┐
│  STAGE 1: AGENT │       │ STAGE 2: AGENT OPS │       │   STAGE 3: COO     │       │   STAGE 4: CFO     │
├─────────────────┤       ├────────────────────┤       ├────────────────────┤       ├────────────────────┤
│ • Submits order │ ────▶ │ • Field & identity │ ────▶ │ • Approves valuation│ ───▶ │ • Posts ledger     │
│   via App       │       │   audit            │       │   term (1-24 mos)  │       │   disbursement     │
│ • Selects Term  │       │ • Captures asset   │       │ • Confirms supplier│       │ • Generates 28%    │
│ • Accepts T&Cs  │       │   GPS & chassis ID │       │   cost & margin    │       │   amortisation rows│
│                 │       │                    │       │                    │       │ • Activates sweep  │
│ Role: Agent     │       │ Role: `agent_ops`  │       │ Role: `coo` ONLY   │       │ Role: `cfo` ONLY   │
└─────────────────┘       └────────────────────┘       └────────────────────┘       └────────────────────┘
```

### 3.2 Daily Wallet Sweep Execution Flow (pg_cron at 03:00 EAT)

```
                     ┌────────────────────────────────────────┐
                     │ pg_cron fires daily at 03:00 EAT       │
                     │ Calls: `run_daily_agent_sweeps()`      │
                     └──────────────────┬─────────────────────┘
                                        │
                                        ▼
                     ┌────────────────────────────────────────┐
                     │ Loop active leases in agent_bike_leases│
                     │ Determine active month (m)             │
                     │ Lookup daily target cap: d(m) from     │
                     │ `agent_bike_lease_schedules`           │
                     └──────────────────┬─────────────────────┘
                                        │
                                        ▼
                     ┌────────────────────────────────────────┐
                     │ Read agent's `withdrawable_balance`    │
                     │ (Commissions earned from rent ops)     │
                     └──────────────────┬─────────────────────┘
                                        │
                  ┌─────────────────────┴─────────────────────┐
                  ▼                                           ▼
      [Withdrawable Bal > 0]                         [Withdrawable Bal == 0]
                  │                                           │
                  ▼                                           ▼
  Calculate sweep amount:                               Deduct UGX 0.
  amt = min(outstanding, wallet, d(m))                  Skip day cleanly.
                  │                                     No penalty, no compound fee.
                  ├────────────────────────┐            If 0 sweeps for 7 days:
                  ▼                        ▼            Trigger 7-Day Dormancy Alert.
  Deduct amt from                 Decrement outstanding
  `withdrawable_balance`          lease balance in DB
                  │                        │
                  └───────────┬────────────┘
                              │
                              ▼
                  Post General Ledger Leg:
                  Dr L2 (Agent Withdrawable Liability)
                  Cr A11 (Asset Finance Receivable)
                              │
                              ▼
                  [Is Outstanding Balance == 0?]
                              │
                     ┌────────┴────────┐
                     ▼                 ▼
                   [YES]              [NO]
                     │                 │
                     ▼                 ▼
          Status ➔ 'completed'    Continue daily
          Auto-issue Certificate  amortisation
          Release Logbook title
```

---

## 4. System Internals: Database Tables, Triggers, Cashflows & Cron Jobs

### 4.1 Database Architecture

1. **`agent_bike_leases` (Dedicated Asset Finance Master Table)**:
   - Primary identifier: `id` (UUID).
   - Agent reference: `agent_id` (UUID).
   - Commercial parameters: `bike_model`, `lease_term_months`, `monthly_rate_pct` (fixed at 28.0), `valuation_amount`, `amount_outstanding`.
   - Physical asset fields: `plate_number`, `chassis_number`, `battery_serial`, `gps_tracker_id`, `logbook_status` (`pending_registration`, `held_by_welile`, `held_by_supplier`, `with_agent`, `released`).
   - Four-Eyes audit trail: `ops_approved_by`, `coo_approved_by`, `cfo_approved_by` (captures both UUID and full name).
   - Status machine: `submitted` ➔ `ops_approved` ➔ `coo_approved` ➔ `approved` ➔ `completed`.

2. **`agent_bike_lease_schedules` (Versioned Amortisation Engine)**:
   - Foreign key to `agent_bike_leases.id`.
   - Pre-computed monthly rows: `month_number`, `opening_balance`, `principal_due`, `fee_due`, `total_due`, `daily_target`, `closing_balance`.

3. **`agent_wallets` (Multi-Bucket Architecture)**:
   - `withdrawable_balance`: The **only** bucket debited by the bike recovery engine.
   - `float_balance`: Operational float for tenant rent financing — strictly protected and never touched by recovery.
   - `advance_balance`: Advance balance bucket.

4. **`general_ledger` (Double-Entry Posting Engine)**:
   - **On CFO Disbursement**:
     - `DEBIT`: Account A11 (Agent Asset Finance Receivable)
     - `CREDIT`: Account L1 (Supplier Payable — Spiro)
   - **On Daily Recovery Sweep**:
     - `DEBIT`: Account L2 (Agent Withdrawable Balance Liability)
     - `CREDIT`: Account A11 (Agent Asset Finance Receivable)

### 4.2 Automated Cron Jobs & Triggers (`pg_cron`)

* **Daily Sweep Cron**:
  - Name: `agent_bike_lease_daily_sweep`
  - Cron Schedule: `0 3 * * *` (03:00 AM Kampala Time, UTC+3)
  - Function: `public.run_daily_agent_sweeps()`
* **7-Day Dormancy Detector**:
  - Evaluates active leases with zero deductions over a 7-day period.
  - Automatically posts an alert to the Agent Ops Dashboard ("Dormant Bike Leases") and pushes a friendly notification to the agent app.
* **Full Settlement Trigger**:
  - Fired when `amount_outstanding <= 0`.
  - Automatically updates `status = 'completed'`, stamps `certificate_issued_at`, generates a legal Certificate of Full Settlement PDF, and marks `logbook_status = 'released'`.

---

## 5. Worked Examples & Mathematical Calculations

### Example 1: 6-Month Lease — Ronald Musana
* **Asset**: Spiro Commando
* **Valuation (Base Principal $B$)**: UGX 4,800,000
* **Term ($n$)**: 6 Months
* **Monthly Rate ($r$)**: 28.0% reducing balance
* **Monthly Principal ($P$)**: $\frac{4,800,000}{6} = \text{UGX } 800,000$

| Month ($m$) | Opening Balance | Principal ($P$) | 28% Facility Fee | Total Due | Daily Target (30d) | Closing Balance |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Month 1** | UGX 4,800,000 | UGX 800,000 | UGX 1,344,000 | **UGX 2,144,000** | **UGX 71,467 / day** | UGX 4,000,000 |
| **Month 2** | UGX 4,000,000 | UGX 800,000 | UGX 1,120,000 | **UGX 1,920,000** | **UGX 64,000 / day** | UGX 3,200,000 |
| **Month 3** | UGX 3,200,000 | UGX 800,000 | UGX 896,000 | **UGX 1,696,000** | **UGX 56,534 / day** | UGX 2,400,000 |
| **Month 4** | UGX 2,400,000 | UGX 800,000 | UGX 672,000 | **UGX 1,472,000** | **UGX 49,067 / day** | UGX 1,600,000 |
| **Month 5** | UGX 1,600,000 | UGX 800,000 | UGX 448,000 | **UGX 1,248,000** | **UGX 41,600 / day** | UGX 800,000 |
| **Month 6** | UGX 800,000 | UGX 800,000 | UGX 224,000 | **UGX 1,024,000** | **UGX 34,134 / day** | **UGX 0** |
| **TOTALS** | — | **UGX 4,800,000** | **UGX 4,704,000** | **UGX 9,504,000** | — | **UGX 0** |

---

### Example 2: 12-Month Lease — Alpha Ssema
* **Asset**: Spiro ChapChap
* **Valuation (Base Principal $B$)**: UGX 4,600,000
* **Term ($n$)**: 12 Months
* **Monthly Rate ($r$)**: 28.0% reducing balance
* **Monthly Principal ($P$)**: $\frac{4,600,000}{12} = \text{UGX } 383,333$

| Month ($m$) | Opening Balance | Principal ($P$) | 28% Facility Fee | Total Due | Daily Target (30d) | Closing Balance |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Month 1** | UGX 4,600,000 | UGX 383,333 | UGX 1,288,000 | **UGX 1,671,333** | **UGX 55,711 / day** | UGX 4,216,667 |
| **Month 2** | UGX 4,216,667 | UGX 383,333 | UGX 1,180,667 | **UGX 1,564,000** | **UGX 52,133 / day** | UGX 3,833,333 |
| **Month 3** | UGX 3,833,333 | UGX 383,333 | UGX 1,073,333 | **UGX 1,456,667** | **UGX 48,556 / day** | UGX 3,450,000 |
| **Month 6** | UGX 2,683,333 | UGX 383,333 | UGX 751,333 | **UGX 1,134,667** | **UGX 37,822 / day** | UGX 2,300,000 |
| **Month 9** | UGX 1,533,333 | UGX 383,333 | UGX 429,333 | **UGX 812,667** | **UGX 27,089 / day** | UGX 1,150,000 |
| **Month 12** | UGX 383,333 | UGX 383,333 | UGX 107,333 | **UGX 490,667** | **UGX 16,356 / day** | **UGX 0** |
| **TOTALS** | — | **UGX 4,600,000** | **UGX 8,372,000** | **UGX 12,972,000** | — | **UGX 0** |

---

### Step-by-Step Daily Sweep Execution Log (Month 1 Live Scenario)

| Day | Event / Earnings | Withdrawable Wallet Before | Sweep Formula: $\min(\text{Bal}, \text{Wallet}, \text{Cap})$ | Deducted | Wallet After | Outstanding Lease Balance | Deduction Logged |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Day 1** | Ronald collects 5 tenant rents, earning **UGX 100,000** commission. | UGX 100,000 | $\min(9,504,000,\; 100,000,\; 71,467)$ | **UGX 71,467** | UGX 28,533 *(Available for cashout)* | **UGX 9,432,533** | Row written in `merchandise_recovery_deductions` |
| **Day 2** | Ronald collects 2 tenant rents, earning **UGX 35,000** commission. | UGX 35,000 | $\min(9,432,533,\; 35,000,\; 71,467)$ | **UGX 35,000** | UGX 0 | **UGX 9,397,533** | Partial deduction row written |
| **Day 3** | Sunday / Rest day. **UGX 0** earned. | UGX 0 | $\min(9,397,533,\; 0,\; 71,467)$ | **UGX 0** | UGX 0 | **UGX 9,397,533** | Day skipped cleanly. Zero penalty. |
| **Day 4** | Ronald collects 8 tenant rents, earning **UGX 150,000** commission. | UGX 150,000 | $\min(9,397,533,\; 150,000,\; 71,467)$ | **UGX 71,467** | UGX 78,533 *(Available for cashout)* | **UGX 9,326,066** | Row written in `merchandise_recovery_deductions` |

---

## 6. Highlighted Operational & Governance Questions (Detailed Clarifications)

---

### Question 1: Who is an "Active Agent"?

An **Active Agent** in the Welile ecosystem is an authorized field representative who satisfies four mandatory criteria:
1. **Verified Registration & KYC**: Fully registered in `agents` with a verified National Identification Number (NIN), verified mobile phone number, and residential verification.
2. **Systemic Status = Active**: Marked `status = 'active'` in the system (neither suspended, terminated, nor flagged for fraud review).
3. **Rolling 30-Day Field Activity**:
   - Manages at least **1 active tenant** on a running Rent Plan.
   - Has processed verifiable rent collections within the previous **30 calendar days**.
4. **Clean Credit Record**: Has zero defaulted advances, zero unaccounted rent collection shortages, and no active recovery disputes.

**Why Activity is Critical for Spiro Bike Qualification**: Welile provides the electric motorbike with **UGX 0 upfront deposit**. The asset self-liquidates through daily rent collection commissions. If an agent is inactive, their wallet generates zero inflows, making lease recovery impossible.

---

### Question 2: Why would or under what circumstance would an agent post another submission on the same account?

The platform enforces a strict lock: **Maximum 1 In-Flight Bike Application per Agent**.

An agent may only submit another application under four legitimate circumstances:
1. **Previous Lease is Fully Settled (`completed`)**: The agent has successfully repaid 100% of their principal and facility fees (`outstanding_balance == 0`). Upon issuance of the Certificate of Full Settlement, the agent is unlocked to apply for a second bike or upgrade to expand their sub-agency fleet.
2. **Previous Application Was Rejected**: The previous application was rejected during Ops Verification, COO Commercial Review, or CFO Treasury Review (with a recorded rejection reason). This releases the submission lock, allowing the agent to re-apply with adjusted terms (e.g. extending from 6 to 12 months, or selecting a lower-valuation model).
3. **Application Was Cancelled**: The application was cancelled by the agent or Ops prior to CFO disbursement.
4. **Zero Running Advances Policy**: Applicants must have **no active or outstanding advance** on their account. If an agent has an existing running advance, they must first finish and clear that advance before they can qualify and submit an application for a Spiro bike lease.

*Submissions while an active lease is actively repaying (`status = 'approved'`) are programmatically refused.*

---

### Question 3: So you also use the same concept here — a 28% is charged monthly and recurring 15%?

**NO. The "recurring 15%" concept is obsolete and has been completely deleted.**

* **The Origin of 15%**: Early prototypes in early 2026 used a crude fallback rule for generic merchandise store purchases: *"sweep 15% of any wallet credit that lands in the account until paid off"*. This was not an interest rate; it was an arbitrary wallet throttle with no fixed term or predictable maturity date.
* **Deletion**: Under Migration `0415_bike_lease_fixed_28pct_reducing_balance.sql`, the constant `BIKE_RECOVERY_RATE = 0.15` and all 0.15 fallback logic were permanently removed from the database and codebase.
* **The Canonical Live Model**: The Spiro bike lease operates **strictly on a 28% monthly reducing-balance schedule**. 
  - Monthly fee = $\text{Opening Balance} \times 28\%$.
  - Daily cap = $\frac{\text{Monthly Principal} + \text{Monthly Fee}}{30}$.
  - There is **no recurring 15% charge** anywhere in the system.

---

### Question 4: "A daily sweep of the agent's available wallet balance, capped at the day's scheduled instalment. Nothing is swept on a day when the wallet is empty" — What wallet bucket is debited from, and what if the user wallet is less than target or empty?

#### A. Which wallet bucket is debited?
The recovery engine strictly debits **`withdrawable_balance`** in `agent_wallets`.
- ✅ **`withdrawable_balance`**: Earned commissions from rent collections. **The ONLY bucket debited.**
- ❌ **`float_balance`**: Company operational float for paying landlords. **NEVER touched.**
- ❌ **`advance_balance`**: Advance liquidity bucket. **NEVER touched.**

#### B. What if the wallet balance is less than the daily instalment?
The sweep takes whatever withdrawable balance is available:
$$\text{Deduction} = \min(\text{Outstanding Balance},\; \text{Withdrawable Balance},\; \text{Daily Cap})$$
*Example*: If the daily target is UGX 71,467, but the agent's wallet holds only UGX 20,000, exactly **UGX 20,000** is swept. The outstanding lease balance drops by UGX 20,000, leaving the wallet balance at UGX 0. The remaining unpaid portion rolls over into unpaid principal without penalties.

#### C. What if the wallet is empty (0 UGX)?
* The sweep deducts **UGX 0**.
* The day is skipped cleanly.
* **No penalty fees**, **no compound interest**, and **no negative wallet balance (overdraft)** are ever created.
* If zero deductions occur for **7 consecutive days**, the system triggers a **Dormancy Alert** for Agent Ops.

---

### Question 5: Why charge 28% yet they pay 15% monthly? (Deep-Dive Analysis)

This question arises from conflating the **old prototype wallet deduction percentage** with an **interest rate**:

1. **The Old 15% Was a Sweep Throttle, Not an Interest Rate**:
   - The 15% rule meant *"take 15% of whatever cash lands in the agent's wallet today"*.
   - If an agent earned UGX 100,000 in commissions, the system took UGX 15,000. It had no relationship to the bike's cost or repayment schedule.
2. **The 28% is an Amortized Reducing-Balance Facility Fee**:
   - It is applied to the **unpaid principal** at the beginning of each month.
   - Because the principal reduces every month ($P = B/n$), the 28% fee decreases rapidly over time.
   - *Example*: On a UGX 4.8M bike over 6 months, Month 1 fee is UGX 1,344,000, but by Month 6, the fee is only UGX 224,000!
3. **Agent Protection & Transparency**:
   - Under the 28% reducing-balance model, agents have a fixed, transparent daily target.
   - Once the daily target is satisfied, **100% of any additional commissions earned that day remain with the agent for immediate cashout**.

---

### Question 6: Why must `manager` be removed from the verification chain allowList?

To enforce strict **Four-Eyes Financial Governance** and regulatory separation of duties:

```
┌──────────────────┐       ┌────────────────────┐       ┌────────────────────┐       ┌────────────────────┐
│ 1. AGENT (SELF)  │ ────▶ │ 2. AGENT OPS ONLY  │ ────▶ │ 3. COO ONLY        │ ────▶ │ 4. CFO ONLY        │
│ Order submission │       │ Field verification │       │ Commercial terms   │       │ Ledger disbursement│
└──────────────────┘       └────────────────────┘       └────────────────────┘       └────────────────────┘
```

* **The Problem with `manager`**: A generic `manager` role is overly broad and allows branch or operational personnel to approve significant capital asset disbursements without executive scrutiny.
* **The Solution**: 
  - Stage 2 is restricted strictly to **`agent_ops`** (verifies physical route and agent KYC).
  - Stage 3 is restricted strictly to **`coo`** (approves valuation, supplier margin, and term).
  - Stage 4 is restricted strictly to **`cfo`** (authorizes treasury disbursement and ledger commitment).
* Removing `manager` prevents bypasses, eliminates collusion risk, and ensures clear fiduciary audit trails.

---

### Question 7: Strategic Assessment & Recommendations on Section 10 (Gaps & Open Decisions)

| Section 10 Item | Status | Strategic Resolution |
| :--- | :---: | :--- |
| **10.1 Day-Count Standardization** | ✅ **Implemented** | Leases follow a canonical flat 30-day month ($\text{Instalment} \div 30$), eliminating calendar-month variations and harmonizing with Rent Plans. |
| **10.2 Arrears & Dormancy Policy** | 🔧 **Staged** | Two-sided visibility: Agent Ops receives a 7-day dormancy alert panel; agents receive an encouraging dashboard banner. At 14 days of inactivity, float issuance is paused pending a physical field audit. |
| **10.3 Logbook Custody & Asset Security** | ✅ **Implemented** | 5-stage logbook state machine (`pending_registration` ➔ `held_by_welile` ➔ `held_by_supplier` ➔ `with_agent` ➔ `released`). Chassis, battery, and GPS IDs are recorded in `agent_bike_leases`. Certificate of Full Settlement auto-generates upon completion. |
| **10.4 Deprecating Legacy Direct Sales** | ✅ **Implemented** | All bike orders route exclusively through `agent_order_spiro_bike_lease` into `agent_bike_leases`. Legacy `merchandise_sales` path is deprecated for vehicles. |
| **10.5 Dedicated Table Architecture** | ✅ **Implemented** | Dedicated tables (`agent_bike_leases` and `agent_bike_lease_schedules`) fully decouple asset finance from generic merchandise. |
| **10.6 Approver Identity Tracking** | ✅ **Implemented** | System records UUID and full name for approvers at each stage (`ops_approved_by`, `coo_approved_by`, `cfo_approved_by`). |
| **10.7 Applicant Data Drilldowns** | ✅ **Implemented** | Verification dialog features clickable drilldown panels for active sub-agents, active tenants, and 30-day collection velocity. |
| **10.8 Valuation-Based Schedule Calculation** | ✅ **Implemented** | 28% reducing-balance calculations apply directly to the principal valuation amount: `spiroLeaseSchedule(term, valuation)`. |

---

### Question 8 (Cross-Product Distinction): How does the system know this is a bike lease since advance logic is already running?

The system maintains strict architectural isolation between Spiro bike leases and working capital advances:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            SYSTEM ISOLATION MATRIX                          │
├──────────────────────────────────────┬──────────────────────────────────────┤
│        A. WORKING CAPITAL ADVANCE     │       B. SPIRO MOTORBIKE LEASE       │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ • Table: `agent_advances`            │ • Table: `agent_bike_leases`         │
│ • Origination: Float request RPC     │ • Origination: `agent_order_spiro_   │
│ • Ledger Account: A10 (Float Adv Rec)│   bike_lease` RPC                    │
│ • Credited: Directly to Float Balance│ • Ledger Account: A11 (Asset Fin Rec)│
│ • Physical Tracking: None (Cash float│ • Physical Tracking: Frame, Chassis, │
│   in system)                         │   Battery, GPS Tracker, Plate        │
│ • Amortisation: Short tenure flat/   │ • Amortisation: Pre-calculated 28%   │
│   pro-rata term (7-90 days)          │   reducing balance rows in           │
│                                      │   `agent_bike_lease_schedules`       │
│ • Recovery: Operational float flows  │ • Recovery: Scheduled daily sweep    │
│                                      │   from withdrawable commissions      │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

1. **Dedicated Database Tables**:
   - Bike leases live exclusively in `agent_bike_leases` and amortize through `agent_bike_lease_schedules`.
   - Advances live exclusively in `agent_advances`.
   - The query engines and recovery jobs read from completely separate tables.
2. **Separate Double-Entry Ledger Accounts**:
   - Bike leases debit **A11 (Agent Asset Finance Receivable)**.
   - Advances debit **A10 (Agent Advance Receivable)**.
3. **Distinct RPC Functions**:
   - Bike approvals use `verify_spiro_bike_lease`, `approve_spiro_bike_lease`, and `disburse_spiro_bike_lease`.
   - Advances use their own standalone advance RPCs.
4. **Physical Asset Metadata**:
   - A bike lease requires plate number, chassis number, battery serial number, GPS tracker ID, and logbook custody state. Advances have no physical asset attributes.

---

## 7. Authorisation & Governance Sign-Off

This document serves as the canonical operating blueprint for Welile's Spiro Electric Motorbike Program.

```
┌─────────────────────────────────┬─────────────────────────────────┬─────────────────────────────────┐
│     CHIEF OPERATING OFFICER     │     CHIEF FINANCIAL OFFICER     │   DIRECTOR OF AGENT OPERATIONS  │
├─────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────┤
│                                 │                                 │                                 │
│ Signature: ____________________ │ Signature: ____________________ │ Signature: ____________________ │
│ Date:      2026-10-07           │ Date:      2026-10-07           │ Date:      2026-10-07           │
│ Welile Technologies Limited     │ Welile Technologies Limited     │ Welile Technologies Limited     │
└─────────────────────────────────┴─────────────────────────────────┴─────────────────────────────────┘
```

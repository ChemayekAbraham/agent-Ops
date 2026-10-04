# Welile Technologies — Business Logic & Financial Documentation

> **Version:** 1.0 — March 2026  
> **Platform:** Welile Technologies Limited  
> **Purpose:** Rent guarantee, rent facilitation, and financial inclusion across Africa.

---

## Table of Contents

1. [Platform Overview](#1-platform-overview)
2. [User Roles & Dashboards](#2-user-roles--dashboards)
3. [Rent Facilitation Flow](#3-rent-facilitation-flow)
4. [Access Fee & Compounding Logic](#4-access-fee--compounding-logic)
5. [Request Fee Structure](#5-request-fee-structure)
6. [Repayment & Auto-Charge System](#6-repayment--auto-charge-system)
7. [Agent Earnings & Commission Structure](#7-agent-earnings--commission-structure)
8. [Agent Advance (Credit) System](#8-agent-advance-credit-system)
9. [Supporter / Funder Investment Model](#9-supporter--funder-investment-model)
10. [Rent Management Pool](#10-rent-management-pool)
11. [Landlord Guaranteed Rent Program](#11-landlord-guaranteed-rent-program)
12. [Credit Access System (Tenant & Agent Loans)](#12-credit-access-system)
13. [Welile Homes Savings Program](#13-welile-homes-savings-program)
14. [Wallet & Deposit System](#14-wallet--deposit-system)
15. [Withdrawal & Payout Approval Hierarchy](#15-withdrawal--payout-approval-hierarchy)
16. [Proxy Investment Flow](#16-proxy-investment-flow)
17. [Referral & Ambassador Rewards](#17-referral--ambassador-rewards)
18. [Revenue Recognition Model](#18-revenue-recognition-model)
19. [Double-Entry Ledger System](#19-double-entry-ledger-system)
20. [Risk, Buffer & Solvency Rules](#20-risk-buffer--solvency-rules)
21. [SMS Notification System](#21-sms-notification-system)
22. [Key Platform KPIs](#22-key-platform-kpis)

---

## 1. Platform Overview

### What is Welile?

Welile is a rent-guarantee and rent-facilitation platform that connects **tenants**, **landlords**, **field agents**, and **supporters (funders)** in a trust-based financial ecosystem. Welile does NOT lend money — it facilitates rent payments, manages risk, and earns service fees for infrastructure and guarantees.

**Example:** A tenant earning UGX 300,000/month needs to pay rent of UGX 200,000 but doesn't have it upfront. Welile pays the landlord immediately using pooled supporter capital, and the tenant repays in small daily instalments over 14–30 days plus a service fee.

---

## 2. User Roles & Dashboards

### Tenant Dashboard

Tenants see their own rent status, wallet balance, repayment schedule, Welile Homes savings, and deposit history. They do NOT see other users or platform internals.

**Example:** Mary, a tenant, logs in and sees: "Rent of UGX 200,000 approved. Daily repayment: UGX 9,867. Next charge: Tomorrow. Welile Homes balance: UGX 45,000."

### Agent Dashboard

Agents see registrations, tasks, earnings, field visit logs, collections, float balance, and sub-agent performance. They do NOT see financial ledgers, other agents' data, or platform-wide metrics.

**Example:** Agent John sees: "5 tenants registered this week. 2 rent requests pending. Earnings this month: UGX 125,000. Float balance: UGX 340,000."

### Landlord Dashboard

Landlords see their property portfolio, rent payment status, balance due, and payment history. They do NOT see other users or platform internals.

**Example:** Landlord Ssemakula sees: "3 properties registered. Rent received this month: UGX 450,000. Outstanding balance: UGX 200,000."

### Supporter / Funder Dashboard

Supporters see **Virtual Houses** (anonymized rent deals), portfolio performance, ROI earned, and investment breakdown. They NEVER see tenant names, phone numbers, agent details, or personally identifiable information — only rent amounts, payment health, and financial outcomes.

**Example:** Supporter Grace sees: "Portfolio: UGX 5,000,000 invested. 12 Virtual Houses funded. Monthly ROI: 15%. Next payout: March 25, 2026."

### Manager / COO Dashboard

Managers see operational flows, approval queues, risk indicators, solvency metrics, and financial summaries. They monitor the system's health and approve/reject financial operations.

**Example:** Manager dashboard shows: "4 pending rent requests. Pool balance: UGX 12,000,000. Coverage ratio: 1.4x. 2 deposit requests awaiting verification."

---

## 3. Rent Facilitation Flow

### How Rent Gets Facilitated (End-to-End)

The rent facilitation process follows a strict multi-stage verification workflow:

**Step 1 — Tenant Registration & Request**  
A tenant (or agent on their behalf) submits a rent request specifying: rent amount, landlord details, property address, duration, and utility meter numbers (electricity/water).

**Step 2 — Agent Verification**  
The field agent visits the property, captures GPS coordinates, verifies the landlord's identity with verification PINs, and confirms tenancy details.

**Step 3 — Manager Approval**  
A manager reviews the request in the "Pending Rent Requests" queue. They verify documentation, check risk factors (no-smartphone indicator 🚫📱, posting source: Agent vs Self), and either approve or reject.

**Step 4 — Pool Deployment (Funding)**  
Upon approval, the system creates a subscription charge, posts a tenant obligation to the ledger, and credits the landlord's wallet. Funds are routed via automated fallback logic:
1. **Landlord's wallet** (matched by phone number)
2. **Caretaker's wallet** (if landlord isn't on platform)
3. **Agent's wallet** (as cash-out proxy for landlord)

**Step 5 — Repayment**  
The tenant repays via daily auto-deductions from their wallet, or through agent-collected cash payments.

**Example:** Tenant Aisha requests UGX 150,000 rent for 21 days. Agent Kato verifies the property at GPS (-0.312, 32.581). Manager approves. Pool deploys UGX 150,000 to Landlord Mukasa's wallet. Aisha repays UGX 9,524/day for 21 days (total UGX 199,996 including fees).

---

## 4. Access Fee & Compounding Logic

### How the Access Fee is Calculated

The access fee is Welile's primary service charge for facilitating rent. It compounds monthly at the tenant's chosen rate.

**Supported Rates:**
| Rate | Label | Use Case |
|------|-------|----------|
| 23% | Low | Shorter durations, returning tenants |
| 28% | Medium | Standard facilitation |
| 33% | High | Higher-risk or longer durations |

**Formula:**
```
accessFee = rentAmount × ((1 + monthlyRate)^(durationDays / 30) − 1)
```

**Example 1 — 30-day facilitation at 33%:**
- Rent: UGX 200,000
- Access Fee = 200,000 × ((1.33)^(30/30) − 1) = 200,000 × 0.33 = **UGX 66,000**

**Example 2 — 14-day facilitation at 28%:**
- Rent: UGX 200,000
- Access Fee = 200,000 × ((1.28)^(14/30) − 1) = 200,000 × 0.1268 = **UGX 25,364**

**Example 3 — 60-day facilitation at 33%:**
- Rent: UGX 200,000
- Access Fee = 200,000 × ((1.33)^(60/30) − 1) = 200,000 × 0.7689 = **UGX 153,780**

The compounding ensures that longer durations carry proportionally higher fees, incentivizing faster repayment.

---

## 5. Request Fee Structure

### One-Time Processing Fee

A flat request fee is charged per facilitation to cover administrative processing:

| Rent Amount | Request Fee |
|-------------|-------------|
| ≤ UGX 200,000 | UGX 10,000 |
| > UGX 200,000 | UGX 20,000 |

**Total Repayment Formula:**
```
totalRepayment = rentAmount + accessFee + requestFee
dailyRepayment = ceil(totalRepayment / durationDays)
```

**Example:**
- Rent: UGX 300,000, Duration: 30 days, Rate: 33%
- Access Fee: UGX 99,000
- Request Fee: UGX 20,000 (rent > 200k)
- Total Repayment: UGX 419,000
- Daily Repayment: ceil(419,000 / 30) = **UGX 13,967/day**

---

## 6. Repayment & Auto-Charge System

### Daily Auto-Deduction Mechanism

The platform uses a wallet-based auto-charge billing system powered by a daily PostgreSQL cron job that triggers at **06:00 AM UTC** every day.

**Process:**
1. System identifies all active subscriptions where `next_charge_date` ≤ today.
2. For each subscription, it attempts to deduct the `charge_amount` from the tenant's wallet.
3. If the tenant's wallet has insufficient funds, the system falls back to the **linked agent's wallet**.
4. If the agent's wallet is also insufficient, the shortfall is recorded as **accumulated debt** against the agent.
5. For tenants without smartphones (`tenant_no_smartphone = true`), the tenant's wallet is skipped entirely and the agent is charged directly.

**Example — Successful charge:**
- Tenant Amina has UGX 15,000 in wallet. Daily charge is UGX 10,000.
- System deducts UGX 10,000. Wallet drops to UGX 5,000.
- `next_charge_date` advances by 1 day. `charges_remaining` decreases by 1.

**Example — Fallback to agent:**
- Tenant Bosco has UGX 2,000 in wallet. Daily charge is UGX 10,000.
- System deducts UGX 2,000 from Bosco, then UGX 8,000 from Agent Peter.
- If Agent Peter has only UGX 3,000: deducts UGX 3,000, records UGX 5,000 as accumulated debt.

### Deposit-Triggered Auto-Repayment

When a tenant deposits funds, the system applies a **debt-clearing hierarchy**:
1. Deduct any outstanding rent balance immediately.
2. Clear any accumulated debt on the subscription.
3. Pre-pay future daily installments if surplus remains (advancing `next_charge_date`).
4. Reset the `tenant_failed_at` grace period tracker.

**Example:**
- Tenant owes UGX 30,000 in accumulated debt + UGX 10,000 daily charge.
- Tenant deposits UGX 80,000.
- System clears UGX 30,000 debt, pays today's UGX 10,000, and pre-pays 4 more days (UGX 40,000).
- Remaining UGX 0. `next_charge_date` jumps forward 5 days.

---

## 7. Agent Earnings & Commission Structure

### How Agents Earn Money

Agents earn through a multi-layered incentive system designed to drive user acquisition and lifecycle management.

#### 7.1 Fixed Activity Rewards

| Activity | Reward |
|----------|--------|
| Tenant Registration | UGX 500 |
| Tenant Verification | UGX 5,000 |
| Rent Verification | UGX 5,000 |
| Approval Bonus (per approved request) | UGX 5,000 |

**Example:** Agent Sarah registers a tenant (UGX 500), verifies them (UGX 5,000), their rent request gets approved (UGX 5,000). Total from one tenant = **UGX 10,500**.

#### 7.2 Commission on Rent Repayments

Agents earn **5% commission** on every rent repayment collected from their assigned tenants.

**Example:**
- Tenant repays UGX 10,000 today.
- Agent commission = 10,000 × 5% = **UGX 500** credited to agent's wallet.

#### 7.3 Sub-Agent (Tiered) Commission Split

When an agent recruits sub-agents, the 5% commission splits:

| Role | Commission Rate |
|------|----------------|
| Sub-Agent (direct collector) | 4% |
| Super Agent (recruiter/parent) | 1% passive override |

**Example:**
- Sub-Agent Kevin collects UGX 50,000 from a tenant.
- Kevin earns: 50,000 × 4% = **UGX 2,000**
- Super Agent Mama Jane earns: 50,000 × 1% = **UGX 500** (passive income)

#### 7.4 Career Path Rewards

| Milestone | Reward |
|-----------|--------|
| Team Leader (2+ sub-agents) | Access to cash advances (UGX 300,000 – 30,000,000) |
| 50 repaying tenants | Electric Bike reward |

#### 7.5 Landlord Management Fee

Agents managing properties for landlords without smartphones earn a **2% management fee** on every rent payment processed for that landlord. This is automatically credited via a database trigger.

**Example:**
- Landlord's rent is UGX 500,000/month.
- Agent management fee = 500,000 × 2% = **UGX 10,000/month** auto-credited.

---

## 8. Agent Advance (Credit) System

### Cash Advances for Agents

Team Leader agents can access cash advances to fund their operations.

**Terms:**
- **Access Fee:** 33% monthly compounding (same formula as rent facilitation)
- **Registration Fee:** UGX 10,000 (principal ≤ 200k) or UGX 20,000 (principal > 200k)
- **Repayment Periods:** 7, 14, 30, 60, or 90 days
- **Daily deduction:** Total payable ÷ period days (auto-deducted from agent wallet at 05:00 UTC)

**Risk Monitoring (Balance-to-Principal Ratio):**
| Status | Condition |
|--------|-----------|
| 🟢 Green (Healthy) | Ratio ≤ 1.0x |
| 🟡 Yellow (Caution) | Ratio > 1.5x |
| 🔴 Red (Critical) | Ratio > 3.0x or Overdue |

**Shortfall Handling:** If the daily deduction fails due to insufficient wallet balance, the shortfall carries forward and compounds at the monthly equivalent daily rate: `1.33^(1/30) − 1 ≈ 0.96%/day`.

**Example:**
- Agent takes UGX 500,000 advance for 30 days.
- Access Fee = 500,000 × 0.33 = UGX 165,000
- Registration Fee = UGX 20,000
- Total Payable = UGX 685,000
- Daily Deduction = ceil(685,000 / 30) = **UGX 22,834/day**

**Top-Ups:** Additional advances merge into the existing active advance, triggering a full recalculation of outstanding balance and daily deductions.

---

## 9. Supporter / Funder Investment Model

### How Supporters Invest and Earn

Supporters contribute capital to the platform's rent management pool. Their funds are used to pay landlords on behalf of tenants. In return, supporters earn monthly rewards.

#### 9.1 Investment Plans

| Plan | Monthly ROI | Description |
|------|-------------|-------------|
| Standard | 15% | Default investment tier |
| Premium | 20% | Higher return for larger/longer commitments |

The ROI rate is stored per portfolio and applied for all calculations.

#### 9.2 Reward Calculation

Rewards compound monthly based on the investment amount:

```
monthlyReward = investmentAmount × (roiPercentage / 100)
```

**Example:**
- Supporter invests UGX 5,000,000 at 15% monthly.
- Month 1 reward = 5,000,000 × 0.15 = **UGX 750,000**
- Month 2 opens at 5,750,000 → reward = 5,750,000 × 0.15 = **UGX 862,500**
- And so on (compound growth).

#### 9.3 Payout Rules

1. **30-day working period:** First payout occurs 30 days after investment date.
2. **Dual-mode payout:**
   - Default: Strict 30-day cycle anchored to investment date.
   - Override: Fixed calendar day (1st–28th) if configured by COO.
3. **Withdrawal policy:** Pauses rewards immediately. Subject to **90-day notice period**.

#### 9.4 What Supporters See (Privacy)

Supporters NEVER see tenant names, landlord details, agent information, or phone numbers. They only see:
- **Virtual Houses:** Anonymized representations of funded rent deals
- **Payment Health:** Green/Yellow/Red indicators
- **Portfolio Performance:** ROI earned, next payout date, investment breakdown

---

## 10. Rent Management Pool

### Central Capital Pool Mechanics

All supporter investments flow into a central **Rent Management Pool** that managers deploy to approved rent requests.

#### 10.1 Pool Metrics

| Metric | Definition |
|--------|-----------|
| Pool Balance | Total capital available |
| Total Deployed | Sum of all disbursed facilitations |
| 15% Reserve | Locked capital for monthly supporter rewards |
| Deployable | Pool Balance − 15% Reserve (safe-to-fund amount) |

#### 10.2 Deployment Rules

- Only requests in the "Ready to Fund" queue (where `funded_at IS NULL`) can receive funds.
- **Pre-payout Liquidity Gate:** Deployment is blocked if pool balance would drop below the 15% reserve threshold.
- Double-funding prevention: Any request with a `funded_at` timestamp is excluded from the queue.

**Example:**
- Pool Balance: UGX 20,000,000
- 15% Reserve: UGX 3,000,000
- Deployable: UGX 17,000,000
- Manager tries to deploy UGX 18,000,000 → **BLOCKED** (exceeds deployable amount)
- Manager deploys UGX 5,000,000 → ✅ Approved. New deployable: UGX 12,000,000

#### 10.3 Deployment Atomic Transaction

When pool funds are deployed, the following happens atomically:
1. Ledger entry: `pool_rent_deployment` (cash_out from pool)
2. Tenant obligation created in ledger
3. Auto-charge subscription created
4. Agent Approval Bonus of UGX 5,000 paid
5. Landlord wallet credited (via routing fallback)
6. SMS notifications sent to tenant and agent

---

## 11. Landlord Guaranteed Rent Program

### How Guaranteed Rent Works

Welile offers landlords a guaranteed monthly rent payment, eliminating vacancy and default risk.

**Structure:**
- Welile charges a **10% platform fee** on the guaranteed rent amount.
- The 10% fee is redirected to the tenant's **Welile Homes savings account** (see Section 13).
- If a tenant fails to pay rent, **Welile pays the landlord** and records the unpaid amount as a **financing obligation** for the tenant at a **28% monthly access fee**.
- Agents earn a **2% commission** on all subsequent rent payments for tenants they onboarded under this guarantee.

**Example:**
- Guaranteed rent: UGX 400,000/month.
- Platform fee: UGX 40,000 → goes to tenant's Welile Homes savings.
- Landlord receives: UGX 400,000 (guaranteed, regardless of tenant payment).
- If tenant defaults: Welile pays UGX 400,000 to landlord, tenant owes UGX 400,000 + 28% access fee = **UGX 512,000**.
- Agent earns: 400,000 × 2% = **UGX 8,000** per month on future payments.

---

## 12. Credit Access System

### Instant Funding Exploration for Tenants & Agents

The Credit Access System provides short-term funding backed by **100% Welile AI Insurance** principal protection.

#### 12.1 Fee Structure

| Fee Type | Rate |
|----------|------|
| Platform Fee | 5% monthly (compounding) |
| Funder Interest | Variable (set by funder, optional) |
| Agent Commission | 5% of total repayment |

**Platform Fee Formula:**
```
platformFee = amount × ((1.05)^(durationDays / 30) − 1)
```

**Example:**
- Credit amount: UGX 500,000, Duration: 30 days, Funder interest: 10%
- Platform Fee = 500,000 × 0.05 = UGX 25,000
- Funder Interest = 500,000 × 0.10 = UGX 50,000
- Total Repayment = 500,000 + 25,000 + 50,000 = **UGX 575,000**
- Daily Repayment = ceil(575,000 / 30) = **UGX 19,167**

#### 12.2 Credit Limit Calculation

Credit limits are dynamic, based on:
- Verified rent payment history
- Number of verified receipts uploaded
- Platform ratings
- Funded rent requests (boosts both tenant and agent limits)
- Landlord rent history

**Maximum cap:** UGX 30,000,000

#### 12.3 Verification Requirements

- UEDCL (electricity) and NWSC (water) meter numbers matched to landlord records
- Landlord contact information
- Borrower's Mobile Money registered name
- GPS location pin of the property

#### 12.4 Credit Statuses

`pending` → `approved` → `active` → `repaid` / `defaulted` / `rejected`

---

## 13. Welile Homes Savings Program

### Automatic Housing Fund

Every time a tenant pays rent, **10% is automatically saved** into their Welile Homes fund.

**Growth Rate:** 5% monthly compound interest on the savings balance.

**Usage Restrictions:** Funds can only be withdrawn for:
- Land purchase
- House purchase
- Mortgage payments

**Example:**
- Tenant pays UGX 200,000 rent. 10% = UGX 20,000 saved.
- After 6 months of regular rent: ~UGX 120,000 saved.
- With 5% monthly compounding: Balance grows to approximately **UGX 137,000**.

**Manager Oversight:** Growth rewards are processed automatically on the 1st of each month. Managers monitor via an administrative interface.

---

## 14. Wallet & Deposit System

### How Money Enters the Platform

Every user has a single wallet. Deposits can occur through:

#### 14.1 Self-Service Deposits

Tenants deposit via Mobile Money and submit a pending deposit request with:
- Amount
- Transaction ID (mandatory)
- Provider (MTN, Airtel, etc.)
- Date and time of transaction

#### 14.2 Agent-Facilitated Deposits (Two Modes)

**Mode 1 — "I Collected Cash" (Agent-Funded):**
- Agent must have sufficient wallet balance.
- Agent's wallet is deducted instantly to credit the customer.
- Triggers auto-repayment logic (clears debts, pre-pays installments).

**Mode 2 — "Customer Paid Directly" (TID-Only):**
- Agent submits a Transaction ID, amount, and customer phone.
- No wallet deduction from agent.
- Creates a `pending` entry for manager verification.
- Enables agents to facilitate transactions regardless of their own balance.

**Example — Agent Collected Cash:**
- Agent has UGX 100,000 wallet balance. Tenant pays UGX 50,000 cash.
- Agent's wallet: 100,000 → 50,000. Tenant's wallet: 0 → 50,000.
- Auto-repayment kicks in: clears UGX 30,000 debt, pre-pays 2 days.

**Example — Customer Paid Directly:**
- Tenant sent UGX 50,000 via MTN MoMo, TID: 12345678901.
- Agent submits TID. Manager verifies against MTN records. Approves deposit.
- Tenant's wallet credited UGX 50,000.

#### 14.3 Manager Deposit Approval

Managers process deposits via the Deposits Management page:
- Server-side pagination with search (name, phone, TID)
- Transaction IDs displayed in a prominent yellow "Verify First" box
- Agent-initiated deposits shown with purple theme and "Verify with Agent" banner
- Supported providers: MTN MoMo, Airtel Money, and other major African mobile money networks

---

## 15. Withdrawal & Payout Approval Hierarchy

### How Money Leaves the Platform

#### 15.1 External Withdrawals (Cash-Out)

All external wallet withdrawals follow a **single-step Financial Ops approval:**

```
Requested (wallet pre-deducted) → Financial Ops Approve & Complete (TID/Receipt/Bank Ref) → Done
If rejected → Idempotent refund via withdrawal_reversal ledger entry
```

Financial Operations reviews the request, selects the payment method (MTN MoMo, Airtel Money, Bank Transfer, or Cash), and enters the corresponding reference to complete.

#### 15.2 Rent Delivery

Deploying pool funds to landlords is a **manager-initiated action** for approved rent requests. This follows the rent approval workflow, separate from the withdrawal approval process.

#### 15.3 Agent Commissions & Proxy Investments

These go through an **approval gate:**
1. System creates a `pending` entry in `pending_wallet_operations`.
2. Manager or executive reviews and approves.
3. Upon approval, funds are credited.
4. If rejected, no credit occurs (and for proxy investments, the agent is refunded).

#### 15.4 Internal Transfers (Instant)

Wallet-to-pool transfers (supporter investing into the rent pool) are processed **instantly** without approval, since the money stays on-platform.

---

## 16. Proxy Investment Flow

### Agents and COO Investing on Behalf of Partners

#### 16.1 Agent-Initiated Proxy Investment

When an agent facilitates an investment for a partner (supporter):

1. Agent's wallet is **immediately debited** for the investment amount.
2. Portfolio is created with `pending_approval` status.
3. Partner credit and agent's **2% commission** are queued in `pending_wallet_operations`.
4. Upon manager/executive approval:
   - Partner's wallet receives a `cash_in` ledger entry.
   - Immediately followed by a `cash_out` entry (category: `wallet_to_investment`).
   - This "net-zero" sequence ensures the partner's liquid balance stays at zero while maintaining a full audit trail.
5. Agent's 2% commission is released.
6. Notifications sent: "Investment Activated" to supporter, "Partner Investment Approved" to agent.

**If rejected:**
- Portfolio status set to `cancelled`.
- Investment amount **refunded to agent's wallet**.

**Example:**
- Agent deposits UGX 1,000,000 for Partner X.
- Agent wallet: 1,500,000 → 500,000.
- Manager approves.
- Partner's ledger: +1,000,000 (cash_in) then −1,000,000 (wallet_to_investment).
- Agent commission: 1,000,000 × 2% = **UGX 20,000** credited.
- Portfolio shows UGX 1,000,000 invested.

#### 16.2 COO-Initiated Proxy Investment

The COO can execute proxy investments directly via the `coo-invest-for-partner` backend function:
- Minimum investment: UGX 50,000.
- Uses double-entry ledger with optimistic locking.
- COO's identity is stored in metadata for audit but user-facing descriptions show "Welile Operations" for professional branding.
- Ledger category: `coo_proxy_investment`.

---

## 17. Referral & Ambassador Rewards

### Referral System

Users earn rewards for referring new users to the platform. Monthly referral rewards are processed via the `process_monthly_referral_rewards` database function.

### Landlord Ambassador Program

Landlords who refer other landlords earn commission:

| Metric | Description |
|--------|-------------|
| Status | `pending` → `active` → `earning` |
| Commission | Based on rent processed through referred landlord |
| Tracking | `rent_processed` and `commission_earned` per referral |

**Example:**
- Landlord A refers Landlord B.
- Landlord B processes UGX 2,000,000 in rent through the platform.
- Landlord A earns commission on that volume (rate defined by platform).

---

## 18. Revenue Recognition Model

### How Welile Recognizes Revenue

Welile uses a **proportional revenue recognition model** — revenue is recognized incrementally as collections occur, NOT upfront.

**Revenue Sources:**
- Access Fees (23%, 28%, or 33% compounding)
- Request Fees (UGX 10,000 or 20,000)
- Platform Fees (5% on credit facilitation)

**How It Works:**

When a tenant makes a repayment, the collected amount is split proportionally between:
1. **Pass-through principal** (goes back to pool / landlord)
2. **Access Fee portion** (Welile revenue)
3. **Request Fee portion** (Welile revenue)

**Example:**
- Total facilitation: Rent UGX 200,000 + Access Fee UGX 66,000 + Request Fee UGX 20,000 = UGX 286,000
- Revenue portion = (66,000 + 20,000) / 286,000 = **30.07%**
- Tenant repays UGX 10,000 today.
- Revenue recognized: 10,000 × 30.07% = **UGX 3,007**
- Principal returned: 10,000 × 69.93% = **UGX 6,993**

The **Receivables Statement** separates "Welile Revenue" from principal and tracks collected vs. uncollected fee income.

---

## 19. Double-Entry Ledger System

### Banking-Grade Financial Integrity

All money movement goes through an **append-only, double-entry ledger**. Balances are NEVER stored or edited directly.

#### 19.1 Ledger Account Groups

| Group | Code | Purpose | Allows Negative |
|-------|------|---------|-----------------|
| User Owned | USER_OWNED | User wallets | No |
| Obligation | OBLIGATION | Debts/commitments | Yes |
| System Control | SYSTEM_CONTROL | Buffer/escrow | Varies |
| Revenue | REVENUE | Deferred/recognized | Varies |
| Expense | EXPENSE | Costs/rewards | Varies |
| Settlement | SETTLEMENT | Banking | Varies |

#### 19.2 How It Works

Every financial action creates **two ledger entries** (debit and credit) that must balance:

**Example — Rent Deployment:**
```
DEBIT:  Rent Pool Account       UGX 200,000  (cash_out)
CREDIT: Landlord Wallet Account UGX 200,000  (cash_in)
```

**Example — Tenant Repayment:**
```
DEBIT:  Tenant Wallet Account   UGX 10,000   (cash_out)
CREDIT: Rent Obligation Account UGX 10,000   (cash_in)
```

#### 19.3 Wallet Synchronization

A database trigger (`sync_wallet_from_ledger`) automatically adjusts user wallet balances whenever a ledger entry is inserted. This ensures:
- Single source of truth
- No double-deductions
- No unauthorized balance edits

**RLS policies deny direct client-side wallet or ledger updates.** Only service-role Edge Functions or manager operations can modify financial state.

#### 19.4 Corrections

Corrections are NEVER made by editing existing entries. Instead, **new reversing entries** are posted:

```
Original:  DEBIT Tenant UGX 10,000
Reversal:  CREDIT Tenant UGX 10,000 (description: "Reversal of [original_id]")
```

---

## 20. Risk, Buffer & Solvency Rules

### Platform Safety Mechanisms

#### 20.1 Coverage Ratio

```
coverageRatio = poolBalance / totalActiveObligations
```

| Threshold | Status | Action |
|-----------|--------|--------|
| > 1.2x | ✅ Healthy | Normal operations |
| 1.0x – 1.2x | ⚠️ Warning | Alert managers |
| < 1.0x | 🔴 Critical | Flag system, block new deployments |

#### 20.2 Reserve Requirement

**15% of active capital** is locked as a reserve for monthly supporter rewards. This amount is excluded from the deployable pool balance.

#### 20.3 Solvency Principles

- Solvency is more important than growth.
- If coverage drops below safe levels, the system flags it, alerts managers, and does NOT continue silently.
- Cash-out exceeding cash-in is flagged as a timing gap, not insolvency.
- Negative balances are prevented at the wallet level.

---

## 21. SMS Notification System

### Africa's Talking Integration

The platform sends transactional SMS via Africa's Talking API for critical events:

| Event | Recipient | Message Content |
|-------|-----------|-----------------|
| Rent Approved | Tenant | Rent amount, daily repayment, start date, reference ID |
| Rent Approved | Agent | Tenant name, amount, bonus earned |
| Rent Rejected | Tenant | Amount, instruction to contact agent |
| Collection Receipt | Tenant + Agent | Amount collected, remaining balance |

**Phone Formatting:**
- Ugandan numbers are auto-formatted to international format (+256...).
- Non-Ugandan numbers are skipped.
- Supports both sandbox and production environments.

---

## 22. Key Platform KPIs

### Metrics That Matter

| KPI | Definition | Source |
|-----|-----------|--------|
| **Rent Secured** (North Star) | Total UGX facilitated per month | Approved rent requests |
| Active Virtual Houses | Number of currently funded rent deals | rent_requests (status: approved/active) |
| Rent Success Rate | % of facilitations fully repaid | amount_repaid / total_repayment |
| Payment Health | Green/Yellow/Red distribution | Subscription charge statuses |
| Capital Utilization | Deployed / Total Pool | Pool metrics |
| Liquidity Buffer | Reserve amount available | 15% of active capital |
| Default Rate | % of facilitations in default | Overdue subscriptions |
| Total Funded | Sum of cash_out ledger entries for categories: supporter_rent_fund, supporter_facilitation_capital, coo_proxy_investment | general_ledger aggregation |
| AVG. Deal | total_funded / active_deals | Derived metric |
| Total Rent Due | Sum of outstanding balances on approved requests | Gross receivable |
| Platform Revenue | Proportionally recognized from fees as repayments occur | Ledger + receivables |
| Agent Collections | Total count and volume of rent collected by agents | agent_collections table |

---

## Cash Flow Summary by Role

### Tenant Cash Flow
```
IN:  Deposits (MoMo, Agent cash)
OUT: Daily auto-deductions (rent repayment)
OUT: 10% to Welile Homes (automatic savings)
```

### Agent Cash Flow
```
IN:  Registration rewards (UGX 500/tenant)
IN:  Verification bonuses (UGX 5,000 each)
IN:  Approval bonuses (UGX 5,000 each)
IN:  5% commission on repayments (or 4% for sub-agents)
IN:  1% passive override on sub-agent collections (super agents)
IN:  2% landlord management fee
IN:  2% proxy investment commission
OUT: Cash advances (with 33% compounding access fee)
OUT: Proxy investments on behalf of partners
OUT: Fallback auto-charge deductions for tenants
```

### Landlord Cash Flow
```
IN:  Rent payments (direct or via guaranteed program)
IN:  Guaranteed monthly rent (even if tenant defaults)
OUT: 10% platform fee on guaranteed rent → tenant's Welile Homes
```

### Supporter / Funder Cash Flow
```
IN:  Monthly ROI rewards (15% or 20% compounding)
OUT: Wallet-to-pool investment (instant, no approval)
OUT: Withdrawals (90-day notice, single-step Financial Ops approval)
```

### Platform (Welile) Cash Flow
```
IN:  Access Fees (23/28/33% compounding monthly)
IN:  Request Fees (UGX 10,000 or 20,000)
IN:  Platform Fees on credit (5% compounding)
IN:  10% guaranteed rent program fees
OUT: Agent commissions and bonuses
OUT: Supporter monthly rewards
OUT: Welile Homes growth rewards (5% monthly)
OUT: Operational expenses
```

---

*This document is the authoritative reference for Welile's business logic. All implementations must align with these rules. Last updated: March 2026.*

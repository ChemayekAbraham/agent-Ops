# Welile Technologies — Supporter / Funder Dashboard & Financial Flow

> **Version:** 1.0 — March 2026  
> **Platform:** Welile Technologies Limited  
> **Audience:** Internal team, partners, and operations  
> **Purpose:** Complete documentation of the Supporter (Funder) wallet ecosystem, investment lifecycle, reward mechanics, and financial flows.

---

## Table of Contents

1. [Who is a Supporter / Funder?](#1-who-is-a-supporter--funder)
2. [Supporter Onboarding](#2-supporter-onboarding)
3. [Supporter Dashboard Overview](#3-supporter-dashboard-overview)
4. [Wallet Ecosystem](#4-wallet-ecosystem)
5. [Funding the Rent Management Pool](#5-funding-the-rent-management-pool)
6. [Investment Portfolio Structure](#6-investment-portfolio-structure)
7. [Monthly Reward Mechanics](#7-monthly-reward-mechanics)
8. [Payout Cycle & Scheduling](#8-payout-cycle--scheduling)
9. [Proxy Investment Flow (Agent-Facilitated)](#9-proxy-investment-flow-agent-facilitated)
10. [COO-Initiated Investment](#10-coo-initiated-investment)
11. [Withdrawal Process & 90-Day Notice](#11-withdrawal-process--90-day-notice)
12. [Reward Pause on Withdrawal](#12-reward-pause-on-withdrawal)
13. [Virtual Houses & Privacy](#13-virtual-houses--privacy)
14. [Supporter Wallet Transaction Categories](#14-supporter-wallet-transaction-categories)
15. [Investment Calculator & Projections](#15-investment-calculator--projections)
16. [Deposit Flow (Adding Money to Wallet)](#16-deposit-flow-adding-money-to-wallet)
17. [Rent Management Pool Mechanics](#17-rent-management-pool-mechanics)
18. [Liquidity Gate & Solvency Protection](#18-liquidity-gate--solvency-protection)
19. [Ledger Entries & Audit Trail](#19-ledger-entries--audit-trail)
20. [Notifications & Communication](#20-notifications--communication)
21. [Complete Cash Flow Diagram](#21-complete-cash-flow-diagram)
22. [Risk & Protections for Supporters](#22-risk--protections-for-supporters)
23. [Key Terms & Glossary](#23-key-terms--glossary)

---

## 1. Who is a Supporter / Funder?

A **Supporter** (also called a **Funder** or **Partner**) is an individual or entity who contributes capital to the Welile rent facilitation ecosystem. Their money is used to pay landlords on behalf of tenants who cannot afford upfront rent. In return, supporters earn **monthly rewards** on their invested capital.

**Key Principle:** Supporters are NOT lenders. They are facilitators who provide capital for rent guarantees, and Welile manages the risk, collections, and repayments.

**Example:**  
Grace contributes UGX 5,000,000 to the Rent Management Pool. This money is used to pay rent for 10 tenants. Grace earns 15% monthly (UGX 750,000) while Welile handles all collection, verification, and repayment logistics.

---

## 2. Supporter Onboarding

Supporters can join through three channels:

### 2.1 Agent-Invited Registration

1. An agent creates a supporter invite via the `create-supporter-invite` function.
2. The system generates a unique activation token and sends login credentials.
3. Default password format: `Welile` + last 6 digits of phone + `!`  
   **Example:** Phone `0700405936` → Password: `Welile405936!`
4. Supporter logs in and lands on their dashboard.

### 2.2 Bulk Import by Operations

- Partners can be imported in bulk via the `import-partners` function.
- Each partner receives a profile, wallet (balance: 0), supporter role, and activation invite.

### 2.3 Self-Registration

- Users sign up and are assigned the supporter role upon account creation.

---

## 3. Supporter Dashboard Overview

The Supporter Dashboard is designed to show **financial outcomes, not personal data**. Supporters see:

| Section | What It Shows |
|---------|--------------|
| **Total Contribution** | Sum of all investments (including pending_approval portfolios) |
| **Return/mo** | Projected monthly return = Investment Amount × ROI% / 100 |
| **Investment Breakdown** | Month-by-month compounding projection table |
| **Virtual Houses** | Anonymized funded rent deals with payment health indicators |
| **Wallet Balance** | Available liquid funds |
| **Transaction History** | Deposits, withdrawals, rewards credited, investments made |
| **Notifications** | Reward payouts, investment confirmations, withdrawal updates |

### What Supporters NEVER See

- ❌ Tenant names, phone numbers, or personal details
- ❌ Landlord information
- ❌ Agent details or performance data
- ❌ Other supporter data
- ❌ Platform-wide metrics or internal operations

---

## 4. Wallet Ecosystem

### 4.1 Wallet Structure

Every supporter has **one wallet** with a single balance denominated in UGX. The wallet is the central hub for all financial activity.

```
┌─────────────────────────────────────────────────┐
│                SUPPORTER WALLET                  │
│                                                  │
│   Balance: UGX 2,500,000                        │
│                                                  │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│   │ DEPOSIT  │→ │  WALLET  │→ │  INVEST  │     │
│   │ (Cash In)│  │ BALANCE  │  │ (Cash Out)│    │
│   └──────────┘  └──────────┘  └──────────┘     │
│        ↑                            │            │
│   ┌──────────┐               ┌──────────┐       │
│   │ REWARDS  │               │ WITHDRAW │       │
│   │ CREDITED │               │ (Cash Out)│      │
│   └──────────┘               └──────────┘       │
└─────────────────────────────────────────────────┘
```

### 4.2 Money Flows INTO the Wallet (Cash In)

| Source | Category | Description |
|--------|----------|-------------|
| Mobile Money Deposit | `deposit` | Self-service or agent-facilitated deposit |
| Monthly Reward | `supporter_platform_rewards` | 15% or 20% monthly ROI on invested capital |
| Investment Interest | `investment_interest` | Legacy interest payments from investment accounts |
| Wallet Transfer | `wallet_transfer` | Funds received from another user |
| Refund | `refund` | Returned capital from rejected proxy investments |

### 4.3 Money Flows OUT of the Wallet (Cash Out)

| Destination | Category | Description |
|-------------|----------|-------------|
| Rent Management Pool | `supporter_rent_fund` | Direct investment into the pool |
| External Withdrawal | `withdrawal` | Cash-out to Mobile Money (single-step Financial Ops approval) |
| Wallet Transfer | `wallet_transfer` | Funds sent to another user |
| Agent Proxy Investment | (deducted by agent) | Agent invests from their wallet on supporter's behalf |

### 4.4 Wallet Balance Integrity

- Wallet balances are **never edited directly** by code or managers.
- All balance changes are triggered by the `sync_wallet_from_ledger` database trigger.
- This trigger fires when a `general_ledger` entry is inserted with a `transaction_group_id`.
- RLS policies deny direct wallet updates from clients.

**Example Flow:**
```
1. Supporter clicks "Fund Pool" with UGX 1,000,000
2. Edge function inserts ledger entry: { direction: "cash_out", category: "supporter_rent_fund", amount: 1,000,000, transaction_group_id: "abc-123" }
3. Database trigger fires: wallet.balance -= 1,000,000
4. Edge function reads updated wallet and confirms new balance
```

---

## 5. Funding the Rent Management Pool

### 5.1 How It Works

When a supporter decides to invest, the following happens atomically:

1. **Wallet Balance Check:** Verify sufficient funds (optimistic locking).
2. **Ledger Entry:** Record `cash_out` with category `supporter_rent_fund`.
3. **Wallet Deduction:** Triggered automatically by the ledger entry (via `sync_wallet_from_ledger`).
4. **Portfolio Creation:** New `investor_portfolios` record with status `active`.
5. **Opportunity Update:** Decrement the "RENT NEEDED NOW" counter.
6. **Notification:** Confirmation with reward projection and first payout date.

### 5.2 Role Enforcement

Only users with the `supporter` role can fund the rent pool directly. Agents, tenants, and landlords are blocked at the edge function level.

### 5.3 Reference ID Format

Every funding transaction gets a unique reference: `WRF` + `YYMMDD` + 4-digit random sequence.  
**Example:** `WRF260312-4827`

### 5.4 Minimum Investment

- Direct pool funding: No strict minimum (any amount > 0)
- Proxy investment (via agent): Minimum UGX 50,000

### 5.5 Complete Example

```
Supporter: Grace
Wallet Balance: UGX 3,000,000
Investment Amount: UGX 2,000,000

BEFORE:
  Wallet: UGX 3,000,000
  Portfolios: 2 (UGX 1M + UGX 500K)

ACTION: Fund Rent Pool with UGX 2,000,000

AFTER:
  Wallet: UGX 1,000,000
  Portfolios: 3 (UGX 1M + UGX 500K + UGX 2M)
  New Portfolio Code: WPF-7291
  Monthly Reward: UGX 2,000,000 × 15% = UGX 300,000
  First Payout: April 11, 2026 (30 days from investment)
  Duration: 12 months
  Total Projected Rewards: UGX 300,000 × 12 = UGX 3,600,000

LEDGER ENTRY:
  direction: cash_out
  category: supporter_rent_fund
  amount: 2,000,000
  linked_party: Rent Management Pool
  reference_id: WRF260312-7291
```

---

## 6. Investment Portfolio Structure

### 6.1 Portfolio Record Fields

Each investment creates a portfolio record with:

| Field | Description | Example |
|-------|-------------|---------|
| `portfolio_code` | Unique identifier | WPF-7291 |
| `investment_amount` | Capital invested | UGX 2,000,000 |
| `roi_percentage` | Monthly return rate | 15 or 20 |
| `roi_mode` | Payout mode | `monthly_payout` or `monthly_compounding` |
| `duration_months` | Investment term | 12 |
| `status` | Portfolio state | `active`, `pending_approval`, `cancelled` |
| `payout_day` | Calendar day override (null = 30-day cycle) | null or 15 |
| `next_roi_date` | Date of next reward payout | 2026-04-11 |
| `maturity_date` | End of investment term | 2027-03-12 |
| `total_roi_earned` | Cumulative rewards paid | UGX 750,000 |

### 6.2 Portfolio Statuses

| Status | Meaning |
|--------|---------|
| `active` | Live, earning rewards, fully operational |
| `pending` | Created, awaiting first payout cycle |
| `pending_approval` | Proxy investment awaiting manager/COO approval |
| `cancelled` | Rejected proxy investment; capital refunded to agent |

### 6.3 Investment Plans

| Plan | Monthly ROI | Who Gets It |
|------|-------------|-------------|
| Standard | **15%** | Default for all new investments |
| Premium | **20%** | Larger/longer commitments (configured per portfolio) |

---

## 7. Monthly Reward Mechanics

### 7.1 Basic Reward Formula

```
monthlyReward = investmentAmount × (roiPercentage / 100)
```

**Standard Plan (15%) Example:**

| Month | Opening Balance | Reward (15%) | Closing Balance |
|-------|----------------|--------------|-----------------|
| 1 | UGX 1,000,000 | UGX 150,000 | UGX 1,150,000 |
| 2 | UGX 1,150,000 | UGX 172,500 | UGX 1,322,500 |
| 3 | UGX 1,322,500 | UGX 198,375 | UGX 1,520,875 |
| 4 | UGX 1,520,875 | UGX 228,131 | UGX 1,749,006 |
| 5 | UGX 1,749,006 | UGX 262,351 | UGX 2,011,357 |
| 6 | UGX 2,011,357 | UGX 301,704 | UGX 2,313,061 |
| ... | ... | ... | ... |
| 12 | UGX 4,345,965 | UGX 651,895 | UGX 4,997,860 |

**Total earnings over 12 months on UGX 1,000,000 at 15% compounding: ~UGX 3,997,860**

### 7.2 Premium Plan (20%) Example

| Month | Opening Balance | Reward (20%) | Closing Balance |
|-------|----------------|--------------|-----------------|
| 1 | UGX 1,000,000 | UGX 200,000 | UGX 1,200,000 |
| 2 | UGX 1,200,000 | UGX 240,000 | UGX 1,440,000 |
| 3 | UGX 1,440,000 | UGX 288,000 | UGX 1,728,000 |
| 6 | UGX 2,985,984 | UGX 597,197 | UGX 3,583,181 |
| 12 | UGX 7,430,084 | UGX 1,486,017 | UGX 8,916,101 |

**Total earnings over 12 months at 20% compounding: ~UGX 7,916,101**

### 7.3 How Rewards Are Processed

The `process-supporter-roi` edge function runs on a scheduled basis:

1. **Fetch** all funded rent requests with a tagged supporter.
2. **Check** each request's `next_roi_due_date` — skip if not yet due.
3. **Skip** supporters with active withdrawal requests (rewards paused).
4. **Calculate** 15% of the rent amount funded.
5. **Insert** ROI payment record in `supporter_roi_payments`.
6. **Queue** the reward in `pending_wallet_operations` for manager approval.
7. **Update** `next_roi_due_date` to 30 days from now.
8. **Notify** the supporter with amount and payment number.

### 7.4 Reward Credit Path

```
ROI Calculated → pending_wallet_operations (status: pending)
                         ↓
              Manager/COO Approves
                         ↓
              general_ledger entry (cash_in, supporter_platform_rewards)
                         ↓
              sync_wallet_from_ledger trigger
                         ↓
              Supporter wallet balance increases
                         ↓
              Notification: "💰 Monthly Reward Credited!"
```

---

## 8. Payout Cycle & Scheduling

### 8.1 Default: Strict 30-Day Cycle

By default, every investment follows a strict 30-day cycle anchored to the investment date.

```
Investment Date: March 12, 2026
First Payout: April 11, 2026 (30 days later)
Second Payout: May 11, 2026 (60 days later)
Third Payout: June 10, 2026 (90 days later)
...and so on for 12 months
```

### 8.2 Override: Fixed Calendar Day

The COO can override the payout cycle to a fixed calendar day (1st–28th of every month).

**Example:**  
- COO sets `payout_day = 15` for a partner.
- All rewards for that partner are paid on the 15th of every month regardless of when they invested.

### 8.3 UI Display

The Supporter Dashboard dynamically shows:
- **30-day cycle:** "Payout Cycle: Every 30 days"
- **Fixed day override:** "Payout day: 15th of every month"

---

## 9. Proxy Investment Flow (Agent-Facilitated)

### 9.1 Overview

Agents in the field collect cash from supporters and invest on their behalf. This is the primary channel for supporters without smartphones or digital literacy.

### 9.2 Step-by-Step Flow

```
Step 1: Agent collects cash from Partner (offline, in person)
Step 2: Agent opens their dashboard → "Invest for Partner"
Step 3: Agent selects Partner, enters amount (min UGX 50,000)
Step 4: Agent's wallet is IMMEDIATELY debited
Step 5: Portfolio created with status "pending_approval"
Step 6: Two items queued in pending_wallet_operations:
        a) Partner wallet credit (cash_in, supporter_facilitation_capital)
        b) Agent 2% commission (cash_in, proxy_investment_commission)
Step 7: Manager/COO reviews and approves
Step 8: Upon approval:
        a) Partner wallet: +amount (cash_in) then -amount (wallet_to_investment) = net zero liquid balance
        b) Agent commission: credited to agent wallet
        c) Portfolio status: "pending_approval" → "active"
Step 9: Notifications sent to both partner and agent
```

### 9.3 Financial Example

```
Agent: John (wallet: UGX 2,000,000)
Partner: Grace
Investment Amount: UGX 1,000,000

IMMEDIATE (before approval):
  John's wallet: 2,000,000 → 1,000,000 (deducted instantly)
  Portfolio: WIP260312-4827, status: pending_approval
  Ledger: cash_out, agent_proxy_investment, UGX 1,000,000

AFTER MANAGER APPROVAL:
  Grace's wallet: +1,000,000 (cash_in) then -1,000,000 (wallet_to_investment) = net zero
  John's commission: 1,000,000 × 2% = UGX 20,000 credited
  Portfolio status: active
  Monthly reward: UGX 1,000,000 × 15% = UGX 150,000

IF REJECTED:
  John's wallet: 1,000,000 → 2,000,000 (refunded)
  Portfolio status: cancelled
  No commission paid
  Grace receives nothing
```

### 9.4 Agent Commission Structure

| Action | Commission | Paid When |
|--------|-----------|-----------|
| Proxy investment facilitation | **2% of investment amount** | Upon manager approval |

**Example:** Agent facilitates UGX 5,000,000 investment → earns UGX 100,000 commission.

### 9.5 Rollback Safety

If any step fails after the agent's wallet is debited:
1. Agent wallet is restored to the original balance.
2. Portfolio record is deleted.
3. Ledger entry is removed.
4. Error message returned to agent.

---

## 10. COO-Initiated Investment

### 10.1 How It Differs

The COO (Chief Operations Officer) can invest from a partner's wallet directly without agent involvement.

| Aspect | Agent Proxy | COO Proxy |
|--------|-------------|-----------|
| Who pays | Agent's wallet | Partner's own wallet |
| Approval needed | Yes (pending_approval) | No (auto-approved) |
| Commission | 2% to agent | None |
| Ledger category | `agent_proxy_investment` | `coo_proxy_investment` |
| Min amount | UGX 50,000 | UGX 50,000 |

### 10.2 Example

```
COO invests UGX 2,000,000 from Partner X's wallet:

1. Partner X's wallet: 2,000,000 → 0
2. Ledger: cash_out, coo_proxy_investment, UGX 2,000,000
3. Portfolio created: status active, roi: 15%
4. Monthly reward: UGX 300,000
5. First payout: 30 days from now
6. Notification to Partner X: "An investment was made for you by our operations team"
```

---

## 11. Withdrawal Process & 90-Day Notice

### 11.1 Policy

Supporters can withdraw their invested capital, but it requires a **90-day notice period**. This protects the pool from sudden liquidity shocks.

### 11.2 Withdrawal Steps

```
Step 1: Supporter submits withdrawal request from dashboard
Step 2: System calculates earliest_process_date (90 days from now)
Step 3: Rewards are IMMEDIATELY PAUSED (rewards_paused = true)
Step 4: Request enters investment_withdrawal_requests with status "pending"
Step 5: After 90 days, operations processes the withdrawal
Step 6: Financial Ops reviews → enters TID/Receipt/Bank Ref → Approved & Complete
Step 7: Funds returned to supporter's wallet or Mobile Money
```

### 11.3 Example Timeline

```
Withdrawal Request: March 12, 2026
Earliest Process Date: June 10, 2026 (90 days)
Rewards Paused: March 12, 2026 (immediately)

March: No reward (paused)
April: No reward (paused)
May: No reward (paused)
June 10: Withdrawal processed and disbursed
```

### 11.4 Financial Impact

```
Investment: UGX 5,000,000
Monthly Reward Rate: 15% = UGX 750,000/month
Rewards Earned Before Withdrawal Request: 3 months × UGX 750,000 = UGX 2,250,000
Rewards Lost During 90-Day Notice: 3 months × UGX 750,000 = UGX 2,250,000

Total Received: UGX 5,000,000 (principal) + UGX 2,250,000 (earned rewards) = UGX 7,250,000
Total Foregone: UGX 2,250,000 (notice period)
```

---

## 12. Reward Pause on Withdrawal

### 12.1 How It Works

When the `process-supporter-roi` function runs, it checks for active withdrawal requests:

```sql
SELECT user_id FROM investment_withdrawal_requests
WHERE rewards_paused = true AND status IN ('pending', 'approved')
```

Any supporter with a matching record is **skipped** — no reward is calculated, no payout is queued.

### 12.2 Rationale

- Prevents paying rewards on capital that's about to leave the platform.
- Encourages long-term commitment.
- Protects pool solvency.

---

## 13. Virtual Houses & Privacy

### 13.1 What Are Virtual Houses?

Virtual Houses are **anonymized representations** of funded rent deals. They allow supporters to see the impact of their investment without exposing any personal information.

### 13.2 What a Virtual House Shows

| Data Point | Visible to Supporter? |
|------------|----------------------|
| Rent amount | ✅ Yes |
| Payment health (Green/Yellow/Red) | ✅ Yes |
| Funding date | ✅ Yes |
| Portfolio code | ✅ Yes |
| Tenant name | ❌ No |
| Tenant phone | ❌ No |
| Landlord name | ❌ No |
| Agent name | ❌ No |
| Property address | ❌ No |

### 13.3 Payment Health Indicators

| Color | Meaning |
|-------|---------|
| 🟢 Green | Tenant is paying on time; no overdue installments |
| 🟡 Yellow | 1-7 days behind on payments |
| 🔴 Red | 8+ days behind; risk of default |

---

## 14. Supporter Wallet Transaction Categories

### 14.1 Cash In (Money Entering Wallet)

| Category Code | Display Name | Source |
|---------------|-------------|--------|
| `supporter_platform_rewards` | Monthly Reward | Automated ROI from funded rent |
| `supporter_facilitation_capital` | Proxy Investment Credit | Agent invested on behalf |
| `deposit` | Deposit | Self-service or agent-facilitated |
| `investment_interest` | Investment Interest | Legacy investment accounts |
| `wallet_transfer` | Transfer Received | From another platform user |
| `refund` | Refund | Rejected proxy investment return |

### 14.2 Cash Out (Money Leaving Wallet)

| Category Code | Display Name | Destination |
|---------------|-------------|-------------|
| `supporter_rent_fund` | Rent Pool Funding | Central Rent Management Pool |
| `coo_proxy_investment` | COO Investment | Pool (initiated by operations) |
| `wallet_to_investment` | Investment Activation | Portfolio (net-zero after proxy approval) |
| `withdrawal` | Withdrawal | External (Mobile Money) |
| `wallet_transfer` | Transfer Sent | To another platform user |

---

## 15. Investment Calculator & Projections

### 15.1 Calculator Logic

The platform provides an investment calculator that shows:

```
Required Investment = Desired Monthly Earnings / ROI Rate

Example:
  Desired Earnings: UGX 500,000/month
  ROI Rate: 15%
  Required Investment: 500,000 / 0.15 = UGX 3,333,333
```

### 15.2 Projection Table (12-Month Compounding at 15%)

For UGX 3,333,333 investment:

| Month | Opening | Reward (15%) | Closing |
|-------|---------|-------------|---------|
| 1 | 3,333,333 | 500,000 | 3,833,333 |
| 2 | 3,833,333 | 575,000 | 4,408,333 |
| 3 | 4,408,333 | 661,250 | 5,069,583 |
| 4 | 5,069,583 | 760,437 | 5,830,020 |
| 5 | 5,830,020 | 874,503 | 6,704,523 |
| 6 | 6,704,523 | 1,005,678 | 7,710,202 |
| 7 | 7,710,202 | 1,156,530 | 8,866,732 |
| 8 | 8,866,732 | 1,330,010 | 10,196,742 |
| 9 | 10,196,742 | 1,529,511 | 11,726,253 |
| 10 | 11,726,253 | 1,758,938 | 13,485,191 |
| 11 | 13,485,191 | 2,022,779 | 15,507,970 |
| 12 | 15,507,970 | 2,326,196 | 17,834,166 |

**Total Earnings: UGX 14,500,833 on initial investment of UGX 3,333,333**

### 15.3 Non-Compounding Mode

In `monthly_payout` mode, rewards are credited to the wallet and NOT reinvested:

```
Month 1-12: UGX 3,333,333 × 15% = UGX 500,000 each month
Total: UGX 500,000 × 12 = UGX 6,000,000
```

---

## 16. Deposit Flow (Adding Money to Wallet)

### 16.1 Self-Service Deposit

1. Supporter sends money via Mobile Money (MTN MoMo, Airtel Money, etc.).
2. Supporter submits deposit request with:
   - Amount
   - Transaction ID (from SMS confirmation)
   - Provider
   - Date & time of transaction
3. Manager verifies the transaction ID against provider records.
4. Upon approval, wallet is credited via the ledger.

### 16.2 Agent-Facilitated Deposit

1. Agent collects cash from supporter.
2. Agent submits deposit from their dashboard specifying the supporter.
3. Two modes:
   - **Agent-funded:** Agent's wallet deducted, supporter's wallet credited.
   - **TID-only:** Agent submits Transaction ID, manager verifies and approves.

### 16.3 Deposit → Invest Workflow Example

```
Step 1: Grace deposits UGX 5,000,000 via MTN MoMo
Step 2: Grace submits deposit request (TID: 1234567890, Provider: MTN)
Step 3: Manager verifies and approves
Step 4: Grace's wallet: 0 → 5,000,000
Step 5: Grace clicks "Fund Rent Pool" with UGX 5,000,000
Step 6: Grace's wallet: 5,000,000 → 0
Step 7: Portfolio created: UGX 5,000,000, 15% monthly, 12 months
Step 8: First reward in 30 days: UGX 750,000
```

---

## 17. Rent Management Pool Mechanics

### 17.1 What Is the Pool?

The Rent Management Pool is a **central capital reservoir** funded by supporter investments. Managers deploy funds from this pool to approved rent requests.

### 17.2 Pool Balance Calculation

```
Pool Balance = Total Supporter Funding (supporter_rent_fund)
             − Total Deployed (pool_rent_deployment)
             − Total Returned (supporter_capital_return)
```

### 17.3 Pool Metrics Dashboard (Manager View)

| Metric | Formula | Example |
|--------|---------|---------|
| Pool Balance | Cash in pool - deployed | UGX 20,000,000 |
| Total Deployed | Sum of all deployments | UGX 45,000,000 |
| 15% Reserve | Pool Balance × 15% (locked) | UGX 3,000,000 |
| Deployable | Pool Balance − 15% Reserve | UGX 17,000,000 |

### 17.4 Pool Deployment (What Happens When Rent Is Funded)

When a manager deploys funds for a tenant's approved rent request:

```
1. Ledger: pool_rent_deployment (cash_out from pool)
2. Tenant obligation created (access fee + request fee + principal)
3. Auto-charge subscription created (daily/weekly installments)
4. Agent Approval Bonus: UGX 5,000 paid to verifying agent
5. Landlord wallet credited via routing fallback:
   a) Landlord's wallet (matched by phone)
   b) Caretaker's wallet (if landlord not on platform)
   c) Agent's wallet (as cash-out proxy)
6. SMS notifications sent to tenant and agent
```

---

## 18. Liquidity Gate & Solvency Protection

### 18.1 Pre-Payout Liquidity Gate

Before deploying pool funds, the system checks:

```
Pool Balance After Deployment > 15% × Active Supporter Capital

Example:
  Pool Balance: UGX 20,000,000
  Active Supporter Capital: UGX 50,000,000
  15% Reserve Required: UGX 7,500,000
  
  Deployment of UGX 15,000,000:
  Pool After: 20,000,000 − 15,000,000 = UGX 5,000,000
  5,000,000 < 7,500,000 → ❌ BLOCKED
  
  Deployment of UGX 10,000,000:
  Pool After: 20,000,000 − 10,000,000 = UGX 10,000,000
  10,000,000 > 7,500,000 → ✅ APPROVED
```

### 18.2 Why 15%?

The 15% reserve ensures there are always enough funds to cover the next month's supporter reward obligations (15% of active capital = one month of rewards).

### 18.3 Solvency Rules

- If coverage drops below safe levels, the system flags it and alerts managers.
- Solvency is **more important** than growth.
- The platform will block new deployments rather than risk insolvency.

---

## 19. Ledger Entries & Audit Trail

### 19.1 Supporter-Related Ledger Categories

| Category | Direction | When | Description |
|----------|-----------|------|-------------|
| `supporter_rent_fund` | cash_out | Supporter invests into pool | Capital moves from wallet to pool |
| `supporter_platform_rewards` | cash_in | Monthly reward payout | 15%/20% ROI credited to wallet |
| `supporter_facilitation_capital` | cash_in | Proxy investment approved | Agent-facilitated capital credit |
| `wallet_to_investment` | cash_out | Proxy investment activated | Net-zero transfer (wallet → portfolio) |
| `supporter_capital_return` | cash_in | Withdrawal processed | Capital returned from pool to wallet |
| `agent_proxy_investment` | cash_out | Agent invests for partner | Agent wallet debited |
| `coo_proxy_investment` | cash_out | COO invests for partner | Partner wallet debited by operations |
| `proxy_investment_commission` | cash_in | Agent commission approved | 2% commission to agent |

### 19.2 Audit Trail Guarantee

Every transaction includes:
- **Date & time** (ISO 8601)
- **Amount** (UGX, integer)
- **Direction** (cash_in / cash_out)
- **Category** (from above)
- **Linked party** (e.g., "Rent Management Pool")
- **Reference ID** (13-digit unique, e.g., WRF260312-4827)
- **Transaction Group ID** (UUID, links related entries)
- **User ID** (who the transaction belongs to)
- **Source table** & **Source ID** (traceability)

### 19.3 Immutability

Ledger entries are **append-only**. Corrections are made only by inserting new reversing entries — never by updating or deleting existing ones.

---

## 20. Notifications & Communication

### 20.1 Notification Types for Supporters

| Event | Title | Example Message |
|-------|-------|-----------------|
| Investment confirmed | 🎉 Thank You for Your Support! | "Your contribution of UGX 2,000,000 will begin working for 30 days..." |
| Monthly reward queued | 💰 Monthly Reward Credited! | "Your 15% monthly reward of UGX 300,000 (payment #3) is pending manager approval." |
| Proxy investment | 🎉 A Contribution Was Made for You! | "Your agent John facilitated UGX 1,000,000 on your behalf..." |
| Withdrawal submitted | 📋 Withdrawal Request Received | "Your withdrawal of UGX 5,000,000 has been submitted. 90-day notice period begins." |
| Investment activated | ✅ Investment Activated | "Your portfolio WPF-7291 is now active and earning rewards." |

### 20.2 SMS Notifications

Critical financial events (large reward payouts, withdrawal approvals) may also trigger SMS via the platform's Africa's Talking integration.

---

## 21. Complete Cash Flow Diagram

```
                    ┌──────────────────┐
                    │   MOBILE MONEY   │
                    │  (MTN, Airtel)   │
                    └────────┬─────────┘
                             │ Deposit
                             ▼
┌────────────────────────────────────────────────────┐
│              SUPPORTER WALLET                       │
│                                                     │
│  ┌─────────┐    Balance    ┌─────────────────┐     │
│  │ Rewards  │──→  UGX   ──→│ Fund Rent Pool  │     │
│  │ (15/20%) │    X,XXX,XXX │ (Invest)        │     │
│  └─────────┘              └────────┬──────────┘    │
│       ↑                            │                │
│  ┌─────────┐                       ▼                │
│  │ Proxy   │         ┌─────────────────────┐       │
│  │ Credit  │         │ RENT MANAGEMENT     │       │
│  │ (Agent) │         │ POOL                │       │
│  └─────────┘         │                     │       │
│                      │ ┌─────────────────┐ │       │
│  ┌─────────┐         │ │ 15% Reserve     │ │       │
│  │Withdraw │←────────│ │ (Locked)        │ │       │
│  │(90-day) │         │ └─────────────────┘ │       │
│  └────┬────┘         │                     │       │
│       │              │ Deployable Capital  │       │
│       ▼              └──────────┬──────────┘       │
│  ┌─────────┐                    │                   │
│  │ MOBILE  │                    ▼                   │
│  │ MONEY   │         ┌─────────────────────┐       │
│  │ CASH OUT│         │ RENT DEPLOYMENT     │       │
│  └─────────┘         │ → Landlord Wallet   │       │
│                      │ → Agent Bonus 5K    │       │
│                      │ → Tenant Obligation │       │
│                      └─────────────────────┘       │
└────────────────────────────────────────────────────┘
                             │
                    Tenant Repays Daily
                             │
                             ▼
                    ┌──────────────────┐
                    │ REPAYMENT SPLIT  │
                    │                  │
                    │ Principal → Pool │
                    │ Access Fee → Rev │
                    │ Request Fee → Rev│
                    └──────────────────┘
```

---

## 22. Risk & Protections for Supporters

### 22.1 Capital Protection Mechanisms

| Protection | Description |
|-----------|-------------|
| **Liquidity Reserve** | 15% of active capital locked for reward obligations |
| **90-Day Withdrawal Notice** | Prevents liquidity shocks from sudden withdrawals |
| **Reward Pause** | Rewards stop immediately when withdrawal is requested |
| **Diversified Deployment** | Pool capital spread across many tenants and rent requests |
| **Agent Verification** | Every rent request verified by field agent before funding |
| **Manager Approval** | Multi-stage approval for all deployments |
| **Optimistic Locking** | Prevents race conditions and double-deductions |
| **Immutable Ledger** | Every UGX movement traceable and auditable |

### 22.2 What Happens If a Tenant Defaults?

1. Auto-charge system attempts daily wallet deduction.
2. If tenant wallet is empty, agent's wallet is charged (fallback).
3. If agent wallet is empty, shortfall recorded as accumulated debt.
4. Default tracking flags the tenant in the system.
5. Welile bears the risk — supporter capital is protected.

### 22.3 Platform's Revenue vs Supporter's Return

```
Tenant pays rent of UGX 200,000 + Access Fee (23%) = UGX 46,000 + Request Fee = UGX 10,000
Total Obligation: UGX 256,000

Revenue Split:
  Principal returned to pool: UGX 200,000 (available for re-deployment)
  Access Fee (Welile revenue): UGX 46,000
  Request Fee (Welile revenue): UGX 10,000

Supporter's reward comes from platform revenue + new capital inflows, NOT directly from tenant repayments.
```

---

## 23. Key Terms & Glossary

| Term | Definition |
|------|-----------|
| **Supporter** | An individual or entity contributing capital to the rent facilitation pool |
| **Funder** | Same as Supporter |
| **Partner** | Same as Supporter (used interchangeably by agents) |
| **Rent Management Pool** | Central capital reservoir funded by supporters, deployed by managers |
| **Virtual House** | Anonymized representation of a funded rent deal |
| **ROI** | Return on Investment — monthly percentage earned on invested capital |
| **Payout Day** | Calendar day when monthly rewards are paid (default: 30-day cycle) |
| **Portfolio** | A record of an individual investment, including amount, ROI, and maturity |
| **Proxy Investment** | Investment made by an agent or COO on behalf of a supporter |
| **Pending Approval** | Status of a proxy investment awaiting manager/COO sign-off |
| **90-Day Notice** | Mandatory waiting period before withdrawal of invested capital |
| **Reward Pause** | Automatic suspension of monthly rewards upon withdrawal request |
| **Liquidity Gate** | System check that blocks deployment if pool drops below 15% reserve |
| **Access Fee** | Service fee charged to tenants (23%, 28%, or 33% compounding monthly) |
| **Request Fee** | Flat fee per rent request (UGX 10,000 or 20,000) |
| **Optimistic Locking** | Concurrency control ensuring wallet balance hasn't changed mid-transaction |
| **Ledger Trigger** | Database trigger (`sync_wallet_from_ledger`) that auto-adjusts wallet balances |
| **Net-Zero Transfer** | Two-step ledger sequence (cash_in + cash_out) that maintains zero liquid balance |
| **Agent Approval Bonus** | UGX 5,000 paid to the agent who verified a funded rent request |

---

> **Document maintained by:** Welile Technologies Operations  
> **Last updated:** March 12, 2026  
> **Status:** Living document — updated as business rules evolve

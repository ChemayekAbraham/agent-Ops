# Agent Dashboard — Complete Flow Documentation

> Last updated: 2026-03-11

---

## Overview

The Agent Dashboard is the primary mobile-first interface for Welile field agents. Agents are the boots-on-the-ground operators who register users (tenants, landlords, supporters), collect rent payments, facilitate investments, verify rent requests, and manage properties — all from their smartphones.

The dashboard is built for speed, offline resilience, and one-handed operation. It uses pull-to-refresh, haptic feedback, skeleton loading, and offline caching for reliable field use.

---

## Dashboard Layout (Top → Bottom)

### 1. Header Bar
- **Role Switcher**: Agents with multiple roles (e.g., agent + supporter) can toggle between dashboards
- **Notification Bell**: Real-time alerts for approvals, earnings, and system events
- **Sign Out**

### 2. Profile Section
- **Avatar** (tappable → navigates to Settings)
- **Agent Name** with **Verified Badge** (purple checkmark if `profile.verified = true`)
- **"Welile Agent"** subtitle
- **AI ID Button**: Quick access to the agent's digital identity card

### 3. Daily Operations Summary Card (`AgentDailyOpsCard`)
A real-time snapshot of the agent's day:
- **Visits Today**: Count of GPS check-ins (`agent_visits` table, filtered by today)
- **Collections Today**: Count and total amount from `agent_collections`
- **Float Gauge**: Visual progress bar showing `collected_today / float_limit` from `agent_float_limits`
- Float resets daily via `reset_agent_float_if_stale()` database function

### 4. Visit Tenant Button (Primary CTA)
Large, prominent button that opens the **Visit Payment Wizard** (`AgentVisitPaymentWizard`):
- **Step 1**: Select tenant from agent's registered tenants
- **Step 2**: GPS check-in (captures latitude, longitude, accuracy via browser Geolocation API, reverse-geocodes location name via Nominatim)
- **Step 3**: Record payment — choose payment method (Cash, MTN MoMo, Airtel Money), enter amount, optional MoMo transaction details
- **Step 4**: SMS confirmation sent to tenant and agent
- Creates records in `agent_visits` and `agent_collections` tables
- Generates a 13-digit tracking ID (REF number) for each collection

### 5. Wallet Balance Card
- Displays current wallet balance in UGX (formatted with commas)
- Shows **Recent Auto-Charges** component (last wallet deductions from subscription system)
- Tapping opens the **Full Screen Wallet Sheet** with:
  - Complete transaction history
  - Deposit dialog
  - Withdrawal dialog
  - Financial statement download

### 6. All Features & Tools Menu Button
Opens the **Agent Menu Drawer** (slide-in from right) containing all agent features organized in sections.

### 7. Credit Access Card
Shows the agent's credit limit and borrowing eligibility, calculated by `recalculate_credit_limit` RPC.

### 8. Rent Payment Guide (`AgentRentPaymentGuide`)
Step-by-step guide for agents on how to process rent facilitation payments.

### 9. Approved Rent Requests Widget (`ApprovedRentRequestsWidget`)
Highly visible green-gradient widget showing rent requests that have been approved and are ready for funding. Non-collapsible for constant visibility.

---

## Agent Menu Drawer — All Features

### Section 1: Agent Actions

| Feature | Component | Description |
|---------|-----------|-------------|
| **Invest for Partner** | `AgentInvestForPartnerDialog` | Proxy investment flow — agent uses their own wallet to invest on behalf of a supporter/funder. Deducts from agent wallet immediately, queues funder credit in `pending_wallet_operations` for manager/COO approval. Creates portfolio in `investor_portfolios` with `pending_approval` status. Agent earns 2% commission. |
| **My Registrations** | `/agent-registrations` page | View all invite links created, their status (pending/activated), and share links via WhatsApp |
| **Proxy Investment History** | `ProxyInvestmentHistorySheet` | Full history of all investments made on behalf of partners with status tracking |
| **My Tenants** | `AgentTenantsSheet` | List of all tenants registered by this agent, with repayment schedules |
| **Register New User** | `UnifiedRegistrationDialog` | Multi-role registration form — can register Tenants, Landlords, Supporters, or other Agents. Generates auth credentials (`phone@welile.user` email pattern), assigns roles via `user_roles` table, triggers referral bonus (UGX 500) |
| **Deposit for User** | `AgentDepositDialog` | Agent deposits funds into any user's wallet. Requires: user phone, amount, MoMo provider, transaction ID, date/time, narration. Agent must have sufficient wallet balance. Creates `deposit_requests` record for manager approval |
| **Issue Cash Receipt** | `AgentReceiptDialog` | Record a cash payment and generate a shareable receipt with payer details |
| **Top Up Tenant Wallet** | `AgentTopUpTenantDialog` | Search for a tenant and add funds to their wallet directly from the agent's wallet |
| **Post Rent Request** | `AgentRentRequestDialog` | Submit a rent facilitation request on behalf of a tenant. Captures: rent amount, landlord details, property info, utility meters, GPS location |
| **My Rent Requests** | `AgentMyRentRequestsSheet` | View all rent requests posted by this agent, verify them, track status |
| **Tenant Repayment Schedules** | Same sheet | View, download PDF, and share via WhatsApp the repayment schedules for funded tenants |
| **Register Sub-Agent** | `RegisterSubAgentDialog` | Recruit and register sub-agents under the agent's tree. Recorded in `agent_subagents` table |
| **Manage Property for Landlord** | `AgentManagedPropertyDialog` | For landlords without smartphones — agent manages their property, collects rent on their behalf for a 2% management fee |
| **My Managed Properties** | `AgentManagedPropertiesSheet` | View all properties the agent manages, request landlord payouts |
| **My Landlords Map** | `AgentLandlordMapSheet` | Interactive Leaflet map showing GPS locations of all registered landlords with navigation |
| **Find Rentals** | `RentalFinderSheet` | Browse all registered rental properties by location/category |

### Section 2: Earnings & Growth

| Feature | Path/Component | Description |
|---------|---------------|-------------|
| **Earnings & Rank System** | `EarningsRankSystemSheet` | Gamified earnings system showing ranks (Bronze → Diamond), earning multipliers, and progression |
| **My Earnings** | `/earnings` | Detailed breakdown of all earnings: referral bonuses (UGX 500/registration), proxy investment commissions (2%), rent repayment commissions (5%), agent approval bonuses (UGX 5,000) |
| **Goals & Progress** | `/agent-analytics` | Monthly targets for registrations and activations. Tracked in `agent_goals` table |
| **My Referrals** | `/referrals` | List of all users referred by the agent with status and earnings |
| **Share & Earn** | `/benefits` | Referral link sharing and earning opportunities |

### Section 3: Business Tools

| Feature | Path | Description |
|---------|------|-------------|
| **Welile Shop** | `/shop` | Marketplace where agents can buy/sell products. Receipt scanning earns loan access up to 30M UGX |
| **My Receipts** | `/my-receipts` | Scanned receipts that contribute to credit limit |
| **My Loans** | `/my-loans` | Active and historical loans |
| **Transactions** | `/transactions` | Full payment and transaction history |
| **Financial Statement** | `/financial-statement` | Downloadable PDF financial statement |
| **Calculator** | `/calculator` | Rent and interest calculator tool |

### Section 4: Management

| Feature | Path | Description |
|---------|------|-------------|
| **Agent Analytics** | `/agent-analytics` | Performance metrics, registration trends, activation rates |
| **My Sub-Agents** | `/sub-agents` | Manage recruited sub-agents |
| **My Withdrawals** | `/earnings` | Commission payout requests and wallet withdrawal history |

### Section 5: More

| Feature | Path | Description |
|---------|------|-------------|
| **Share App** | `/install` | PWA install prompt and app sharing |
| **Agent Agreement** | `/agent-agreement` | Terms and conditions for agents |
| **Settings** | `/settings` | Account preferences, avatar, phone |
| **Help & Support** | `/help` | Support resources |

---

## Verification Guides (In Menu Drawer)

### How to Verify a Tenant
Step-by-step field guide with collapsible sections:
1. Visit the tenant's home
2. Confirm identity with landlord
3. Check utility meters (electricity/water)
4. Capture GPS location
5. Take photos if required
6. Submit verification

### How to Verify a Landlord
Similar step-by-step guide for landlord verification.

---

## Key Financial Flows

### A. Agent Deposit Flow
```
Agent opens Deposit Dialog
  → Enters tenant phone, amount, MoMo provider, transaction ID
  → System validates agent has sufficient wallet balance
  → Creates deposit_request (status: pending)
  → Manager/COO approves via Deposits Management page
  → On approval: tenant wallet credited via general_ledger + sync_wallet_from_ledger trigger
```

### B. Proxy Investment Flow (Invest for Partner)
```
Agent opens Invest for Partner Dialog
  → Selects partner (supporter) from list
  → Enters investment amount (min UGX 50,000)
  → System deducts from agent wallet immediately
  → Creates investor_portfolio (status: pending_approval)
  → Queues supporter credit in pending_wallet_operations
  → Queues agent 2% commission in pending_wallet_operations
  → Manager/COO approves:
    → Ledger cash_in (supporter_facilitation_capital) credits funder wallet
    → Ledger cash_out (wallet_to_investment) debits funder wallet back to 0
    → Portfolio status → active
    → Funder gets "Investment Activated ✅" notification
    → Agent gets "Partner Investment Approved ✅" notification
  → OR Manager/COO rejects:
    → Portfolio status → cancelled
    → Agent wallet restored (refunded)
    → Both parties notified
```

### C. Rent Collection Flow (Visit Tenant)
```
Agent taps "Visit Tenant"
  → Step 1: Select tenant
  → Step 2: GPS check-in (browser geolocation)
    → Records in agent_visits (lat, lon, accuracy, location_name)
  → Step 3: Record payment
    → Payment method: Cash / MTN MoMo / Airtel Money
    → Amount, optional MoMo details
    → Validates against float_limit
    → Records in agent_collections with 13-digit tracking ID
    → Updates float (collected_today)
  → Step 4: SMS receipt sent to tenant and agent
```

### D. Rent Request Flow
```
Agent taps "Post Rent Request"
  → Fills: tenant, landlord, rent amount, property details, GPS, utility meters
  → Creates rent_request (status: pending)
  → Agent verifies in field → agent_verified = true
  → Manager reviews and approves → status: approved
  → Landlord verification (optional) → verified = true
  → Manager deploys funds from pool → status: funded
  → Creates tenant obligation and auto-charge subscription
```

---

## Database Tables Used by Agent Dashboard

| Table | Purpose |
|-------|---------|
| `profiles` | Agent profile (name, phone, avatar, verified status, territory) |
| `wallets` | Agent wallet balance |
| `user_roles` | Role assignments (agent role) |
| `agent_earnings` | All earnings records (referral_bonus, proxy_investment_commission, etc.) |
| `agent_float_limits` | Daily float capacity, collected_today, thresholds |
| `agent_visits` | GPS check-in records |
| `agent_collections` | Payment collection records with tracking IDs |
| `payment_tokens` | Time-limited 6-digit payment tokens (30 min expiry) |
| `agent_goals` | Monthly registration/activation targets |
| `agent_subagents` | Sub-agent tree relationships |
| `agent_commission_payouts` | Commission withdrawal requests |
| `agent_receipts` | Cash receipt records |
| `investor_portfolios` | Proxy investment portfolios |
| `pending_wallet_operations` | Queued financial operations awaiting approval |
| `deposit_requests` | Deposit requests awaiting manager approval |
| `rent_requests` | Rent facilitation requests |
| `landlords` | Landlord records with GPS coordinates |
| `general_ledger` | All financial transactions (append-only, double-entry) |
| `notifications` | In-app notification feed |
| `credit_access_limits` | Credit limit calculations |

---

## Edge Functions Used by Agent Dashboard

| Function | Trigger | Purpose |
|----------|---------|---------|
| `agent-deposit` | Deposit for User | Process agent-initiated deposit for a tenant |
| `agent-invest-for-partner` | Invest for Partner | Proxy investment with wallet deduction and approval queuing |
| `agent-withdrawal` | Wallet withdrawal | Submit withdrawal request |
| `create-supporter-invite` | Register User (supporter) | Create supporter invite with activation OTP |
| `create-investor-portfolio` | During registration | Create portfolio record during onboarding |
| `activate-supporter` | N/A (supporter-side) | Activate supporter account with OTP |
| `approve-wallet-operation` | Manager/COO action | Approve/reject queued financial operations |
| `approve-deposit` | Manager/COO action | Approve/reject deposit requests |
| `wallet-transfer` | Top Up Tenant | Transfer funds between wallets |
| `validate-and-record-collection` | Visit wizard | Atomic token validation + collection recording |
| `auto-charge-wallets` | Daily cron (06:00 UTC) | Process subscription installments |
| `product-purchase` | Welile Shop | Purchase marketplace products |

---

## Offline Support

The agent dashboard implements offline-first architecture via `useOfflineAgentDashboard` hook:
- **Cached Stats**: tenants count, referral count, sub-agent count stored in `localStorage`
- **Offline Banner**: Displays when `navigator.onLine` is false
- **Graceful Degradation**: Shows last-known data with a manual refresh button
- **Pull-to-Refresh**: Swipe down to reload all data when back online

---

## Earning Types & Amounts

| Earning Type | Amount | Trigger |
|-------------|--------|---------|
| `referral_bonus` | UGX 500 | Registering any new user |
| `proxy_investment_commission` | 2% of investment | Facilitating a partner investment |
| `rent_repayment_commission` | 5% of repayment | When a tenant repays rent |
| `agent_approval_bonus` | UGX 5,000 | When a facilitated rent request is funded |
| `management_fee` | 2% of rent | Managing a property for a landlord |

---

## Security & Access Control

- Agent can only see their own data (RLS policies on all tables)
- Financial operations require sufficient wallet balance
- Proxy investments are gated by manager/COO approval
- Deposits require manager approval before crediting
- Float limits prevent over-collection
- GPS coordinates are captured and verified for collections
- 60-second cooldown on rapid financial operations (optimistic locking)
- Agent cannot directly edit wallet balances — all changes via ledger triggers

---

## Mobile Bottom Navigation

The agent dashboard includes a persistent bottom navigation bar (`MobileBottomNav`) with quick access to core sections based on the current role.

---

*This document is auto-generated from the Welile platform codebase. For the full system architecture, see `public/SYSTEM_STRUCTURE.md`.*

# COO Dashboard — Complete Documentation v2.0

> **Audience**: Internal staff, agents, and operations personnel  
> **Last Updated**: 2026-04-10  
> **Route**: `/coo/dashboard`  
> **Role Required**: `coo`

---

## Table of Contents

1. [Dashboard Architecture](#1-dashboard-architecture)
2. [Sidebar Navigation](#2-sidebar-navigation)
3. [Overview (Home Page)](#3-overview-home-page)
4. [Rent Approvals](#4-rent-approvals)
5. [Transactions](#5-transactions)
6. [Agent Collections](#6-agent-collections)
7. [Wallets & Financial Ops](#7-wallets--financial-ops)
8. [Agents (Agent Hub)](#8-agents-agent-hub)
9. [Payment Analytics](#9-payment-analytics)
10. [Financial Reports](#10-financial-reports)
11. [Risk & Alerts](#11-risk--alerts)
12. [Withdrawal Approvals](#12-withdrawal-approvals)
13. [Partners](#13-partners)
14. [Partner Top-ups](#14-partner-top-ups)
15. [Partner Financial Activity](#15-partner-financial-activity)
16. [Staff Performance](#16-staff-performance)
17. [Approval Workflows & Chains](#17-approval-workflows--chains)
18. [Database Tables & Backend](#18-database-tables--backend)
19. [Case Scenarios](#19-case-scenarios)

---

## 1. Dashboard Architecture

The COO Dashboard is a single-page application (SPA) built on React. It uses a **tab-based** navigation system where the sidebar selects the active "tab" and the right content area renders the corresponding panel.

### Layout Structure

```
┌─────────────────────────────────────────────────────────┐
│  ExecutiveDashboardLayout (role="coo")                  │
│ ┌──────────────┬────────────────────────────────────────┐│
│ │  Sidebar     │  Content Area                         ││
│ │  (left)      │  (renders based on activeTab)         ││
│ │              │                                       ││
│ │  Financial   │  [Dynamic content panel]              ││
│ │  Operations  │                                       ││
│ │  ──────────  │                                       ││
│ │  Governance  │                                       ││
│ └──────────────┴────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

### Mobile Behavior

On mobile, the sidebar collapses into a bottom/hamburger menu. Each sub-page renders a "← Back to Overview" button for easy navigation.

### Key Files

| File | Purpose |
|------|---------|
| `src/pages/coo/Dashboard.tsx` | Main page, tab routing, content switching |
| `src/components/layout/executiveSidebarConfig.ts` | Sidebar menu definition |
| `src/components/layout/ExecutiveDashboardLayout.tsx` | Shared layout wrapper |

---

## 2. Sidebar Navigation

The sidebar is split into two sections:

### Section: Financial Operations

| Menu Item | Tab ID | Icon | Description |
|-----------|--------|------|-------------|
| Overview | `overview` | Activity | Home dashboard with KPIs and quick actions |
| Rent Approvals | `rent-approvals` | ClipboardList | Queue of rent requests needing COO sign-off |
| Transactions | `transactions` | ClipboardList | Full general ledger browser |
| Agent Collections | `collections` | Users | Agent payment collection performance |
| Wallets | `wallets` | Wallet | Financial Ops Command Center |
| Agents | `agent-activity` | Activity | Executive Agent Hub (two-panel layout) |
| Payment Analytics | `analytics` | BarChart3 | Payment mode pie chart breakdown |

### Section: Governance

| Menu Item | Tab ID | Icon | Description |
|-----------|--------|------|-------------|
| Reports | `reports` | FileText | Download financial reports (CSV) |
| Alerts | `alerts` | AlertTriangle | Financial anomaly detection |
| Withdrawal Approvals | `withdrawals` | Banknote | Final withdrawal sign-off (user + partner) |
| Partners | `partners` | Handshake | Full partner/supporter management |
| Partner Finance | `partner-finance` | Receipt | Unified partner financial activity stream |
| Partner Top-ups | `partner-topups` | TrendingUp | Pending portfolio top-up requests |
| Staff Performance | `staff-performance` | UserCheck | Team productivity metrics |

---

## 3. Overview (Home Page)

**Tab ID**: `overview` (default)  
**Component**: Inline in `Dashboard.tsx`

The landing page is an executive command center with four sections:

### 3.1 Rent Pipeline Queue (Priority)

Shows rent requests at the `landlord_ops_approved` stage, waiting for COO operational sign-off. This queue is the **primary action item** — it appears at the very top.

**What it shows**: Each request card displays tenant name, landlord, property, rent amount, repayment schedule, and the approval trail (who approved at each previous stage).

**Action**: COO can approve (forwards to CFO for payout) or reject with a reason.

### 3.2 Financial Metrics Cards

Seven color-coded metric tiles with health indicators (green/yellow/red borders):

| Metric | Source Table | Calculation | Health Logic |
|--------|-------------|-------------|--------------|
| Total Rent Collected | `general_ledger` | SUM of `rent_repayment` cash_in entries (production + legacy_real) | Always green |
| Payments Today | `general_ledger` | SUM of today's entries | Always green |
| Payments This Month | `general_ledger` | SUM of entries since 1st of month | Always green |
| Agent Collections | `agent_collections` | SUM of all collection amounts | Always green |
| System Wallet Balance | `wallets` | SUM of all wallet balances | Green if > 0, Red if ≤ 0 |
| Pending Approvals | `withdrawal_requests` | COUNT where status = 'pending' | Yellow if > 5 |
| Failed Transactions | `withdrawal_requests` | COUNT where status = 'failed' | Red if > 0 |

**Data limit**: Each query is capped at 500 rows. Stale time: 5 minutes.

### 3.3 Quick Navigation Grid

A grid of 13 tappable cards for instant navigation to any sub-section. Each card shows an icon, label, and one-line description. On click, it sets the active tab and scrolls to top.

**Cards**: Rent Approvals, Wallets & Ops, Transactions, Collections, Withdrawals, Agent Activity, Analytics, Partners, Reports, Alerts, Partner Top-ups, Partner Finance, Staff.

### 3.4 Summary Panels

Two side-by-side panels at the bottom:
- **Payment Mode Analytics** — Pie chart of collection methods
- **Financial Alerts** — Recent anomalies and failed transactions

### 3.5 Share & Recruit Button

A button in the Quick Actions header generates a supporter recruitment link (`/auth?role=supporter&ref={userId}`) that can be copied or shared via WhatsApp.

---

## 4. Rent Approvals

**Tab ID**: `rent-approvals`  
**Component**: `RentPipelineQueue` (stage: `landlord_ops_approved`)

### What It Does

Displays rent requests that have been approved by Landlord Ops and are now waiting for **COO operational sign-off**. This is Step 4 of the 5-step rent approval pipeline.

### The 5-Step Rent Approval Pipeline

```
1. Pending → Tenant Ops reviews, assigns an agent, approves
2. tenant_ops_approved → Agent verifies tenant/property on-site
3. agent_verified → Landlord Ops validates landlord details
4. landlord_ops_approved → ★ COO gives operational clearance ★
5. coo_approved → CFO authorizes payout, funds agent float
```

### What COO Sees Per Request

- **Tenant**: Name, phone, city
- **Landlord**: Name, phone, property address
- **Financial**: Rent amount, repayment amount (with fees), payment schedule
- **Trail**: Who approved at each prior stage and when
- **Agent**: Assigned agent name (if applicable)

### Actions Available

| Action | Result | Database Change |
|--------|--------|-----------------|
| **Approve** | Forwards to CFO payout queue | `rent_requests.status` → `coo_approved`, sets `coo_reviewed_by` and `coo_reviewed_at` |
| **Reject** | Sends back with reason | `rent_requests.status` → `rejected`, stores rejection reason |

### Case Scenario

> **Scenario**: Agent Moses verified tenant Amina's rent request for UGX 500,000. Landlord Ops confirmed the landlord details. The request now appears in the COO queue.
>
> **COO Action**: Reviews the request, confirms the amounts match, and clicks "Approve & Forward to CFO". The request moves to `coo_approved` status. The CFO now sees it in their payout queue.
>
> **If COO rejects**: Provides a reason (e.g., "Rent amount exceeds property value — needs re-verification"). The request goes back to rejected state and Tenant Ops is notified.

---

## 5. Transactions

**Tab ID**: `transactions`  
**Component**: `FinancialTransactionsTable`

### What It Does

Full general ledger browser with search, filtering, pagination, and CSV export. This is the COO's window into **every financial movement** in the system.

### UI Features

| Feature | Details |
|---------|---------|
| **Search** | Searches across reference ID, linked party, category (400ms debounce) |
| **Direction Filter** | All / Cash In / Cash Out |
| **Category Filter** | Dynamic — fetches unique categories from the ledger |
| **Pagination** | Server-side, 50 rows per page via `get_paginated_transactions` RPC |
| **CSV Export** | Downloads visible page as CSV with date stamp |

### Columns Displayed

| Column | Source |
|--------|--------|
| Date | `transaction_date` (formatted: MMM d, yyyy + time) |
| Reference | `reference_id` (first 13 chars) |
| Category | `category` (underscores replaced with spaces) |
| Direction | `direction` — badge: ↓ IN (green) / ↑ OUT |
| Amount | `amount` — green for cash_in, normal for cash_out |
| Linked Party | `linked_party` |
| Description | `description` |

### Backend

- **RPC**: `get_paginated_transactions(p_limit, p_offset, p_direction, p_category, p_search)`
- Returns rows with a `total_count` field for pagination
- Stale time: 2 minutes

### Case Scenario

> **Scenario**: The CFO reports a discrepancy in yesterday's reconciliation. The COO opens Transactions, sets Direction = "Cash Out", searches for the landlord name "Nakato", and finds a duplicate payout of UGX 800,000.
>
> **Next Steps**: COO exports the CSV, forwards to CFO with the reference IDs, and the duplicate is investigated via the audit trail.

---

## 6. Agent Collections

**Tab ID**: `collections`  
**Component**: `AgentCollectionsOverview`

### What It Does

Shows a performance table of all agents who have recorded rent collections, with breakdowns by time period.

### Columns

| Column | Description |
|--------|-------------|
| Agent | Name from `profiles` |
| Today | Sum of collections created today |
| This Week | Sum since Monday |
| This Month | Sum since 1st of month |
| Visits | Total check-ins from `agent_visits` |
| Payments | Total payment count from `agent_collections` |

### Data Flow

```
agent_collections → group by agent_id → join profiles for name
agent_visits → count by agent_id → merge into same table
Sort by monthly amount (descending)
```

### Case Scenario

> **Scenario**: It's mid-month and the COO wants to know which agents are performing. They open Collections and see Agent Joseph has UGX 2.4M this month with 45 visits, while Agent Sarah has UGX 300K with only 8 visits.
>
> **Action**: COO flags Sarah for underperformance follow-up via Staff Performance panel or direct escalation.

---

## 7. Wallets & Financial Ops

**Tab ID**: `wallets`  
**Component**: `FinancialOpsCommandCenter` (with `requirePaymentRef=false`)

### What It Does

Embeds the **full Financial Operations Command Center** within the COO dashboard. This is the same interface used by Financial Ops staff, giving the COO oversight of all wallet and payment operations.

### Available Tools

| Tool | ID | What It Does |
|------|----|--------------|
| **Verify Deposits** | `deposits` view | TID verification for incoming deposits |
| **Ops Center** | `ops` | Scale dashboard with system health metrics |
| **Approval Queue** | `queue` | Pending wallet operations awaiting approval |
| **Transaction Search** | `search` | Advanced search across all transactions |
| **Reconciliation** | `recon` | Daily/weekly reconciliation dashboard |
| **Ledgers** | `ledgers` | Full ledger hub with filtering |
| **Audit Trail** | `audit` | Chronological feed of all auditable actions |
| **Withdrawals & Payouts** | `withdrawals` | Process withdrawal and payout requests |
| **Capital Opportunities** | `opportunities` | Opportunity summary for capital allocation |
| **Wallet Deductions** | `deductions` | Deduct from user wallets (min 10-char reason required) |
| **Fund Requisitions** | `requisitions` | Agent fund requisition forms |

### Navigation

- **Home** shows the main menu grid with all tools
- Clicking any tool opens it in a sub-view with a "← Back" button
- **Deposit Stats** toggle shows/hides aggregate deposit statistics
- **More Tools** sheet provides overflow access

### Case Scenario

> **Scenario**: An agent submits a requisition for UGX 1,500,000 float top-up. The COO opens Wallets → Fund Requisitions, reviews the agent's current float balance and collection history, then approves the requisition.
>
> **Alternative**: A tenant complains about a missing deposit. COO opens Wallets → Transaction Search, locates the transaction by phone number, and confirms it was processed. If the deposit is stuck, they use Verify Deposits to cross-check the TID.

---

## 8. Agents (Agent Hub)

**Tab ID**: `agent-activity`  
**Component**: `COOAgentHub`

### What It Does

Executive-grade, two-panel agent management interface. Designed to handle 5,000+ agents efficiently via server-side aggregation.

### Layout

```
┌──────────────────────┬──────────────────────────────────────────┐
│  LEFT PANEL (260px)  │  RIGHT PANEL (flex-1)                   │
│  bg-[#1a1f3d]        │                                         │
│                      │  [Search Input] [Sort Dropdown]          │
│  All Agents  (5772)  │                                         │
│  Active      (3100)  │  ┌─ Agent Row ─────────────────────┐    │
│  Inactive    (1200)  │  │ Avatar Name  Tenants Landlords  │    │
│  Pending     (800)   │  │ Commission  Wallet  Status      │    │
│  Top Perf.   (200)   │  └─────────────────────────────────┘    │
│  At Risk     (472)   │  ...                                    │
│                      │                                         │
│  ── KPI Summary ──   │  [Load more (50 of 5772)]               │
│  Total Commission    │                                         │
│  Avg Wallet Balance  │                                         │
│  Total Agents        │                                         │
└──────────────────────┴──────────────────────────────────────────┘
```

### Left Navigation Panel

Deep navy (`#1a1f3d`) panel with status categories:

| Category | Classification Logic |
|----------|---------------------|
| **All Agents** | All agents with role `agent` in `user_roles` |
| **Active** | `last_active_at` within 7 days AND commission ≤ 200,000 |
| **Inactive** | `last_active_at` between 7-30 days ago |
| **Pending** | No `last_active_at` (never logged in) |
| **Top Performers** | `total_commission` > UGX 200,000 |
| **At Risk** | `last_active_at` > 30 days ago |

**KPI Summary** (bottom of left panel):
- Total Commission: Sum of all loaded agents' commissions
- Avg Wallet Balance: Average across all loaded agents
- Total Agents: Server-side count from RPC

### Right Content Panel

| Feature | Details |
|---------|---------|
| **Search** | Searches by agent name (server-side via RPC) |
| **Sort** | Name (A-Z), Commission (high→low), Tenants (high→low) |
| **Agent Row** | Avatar initial, name, tenant count, landlord count, commission, wallet balance, status badge |
| **Pagination** | 50 agents per page, "Load more" button |
| **Click** | Opens Agent Detail Drawer |

### Mobile

Left panel collapses to a horizontal scrollable chip bar with category filters.

### Backend: `get_agents_hub` RPC

```sql
-- Parameters:
--   search_query text     — filters profiles.full_name ILIKE
--   sort_field text       — 'full_name', 'total_commission', or 'tenants_count'
--   sort_dir text         — 'asc' or 'desc'
--   page_limit int        — default 50
--   page_offset int       — default 0
--
-- Returns per row:
--   id, full_name, phone, territory, last_active_at,
--   wallet_balance, total_commission, tenants_count,
--   landlords_count, total_count (for pagination)
--
-- Joins:
--   user_roles (role='agent') → profiles → wallets → agent_earnings → rent_requests → agent_landlord_assignments
```

### Agent Detail Drawer

**Component**: `AgentDetailDrawer`  
**Trigger**: Click any agent row  
**UI**: Slide-in sheet from right side

| Section | Data Source | Details |
|---------|-------------|---------|
| **Header** | `profiles` | Name, phone, territory, join date |
| **KPI Row** | `wallets`, `agent_earnings` | Wallet balance, Total commission, Tenant count |
| **Commission History** | `agent_earnings` | Last 10 entries (type, date, amount) |
| **Linked Tenants** | `rent_requests` | Deduplicated by `tenant_id`, shows name + phone |
| **Linked Landlords** | `agent_landlord_assignments` | Joined with `landlords` table, shows name + phone |
| **Recent Activity** | `agent_visits` | Last 8 visits (tenant name, location, timestamp) |

### Case Scenario

> **Scenario**: The CEO asks "How many agents are at risk of churning?" The COO opens the Agent Hub, clicks "At Risk" (472 agents with no activity in 30+ days). They sort by Commission (high → low) to prioritize agents who *were* performing but stopped.
>
> **Action**: COO clicks on Agent David (UGX 850,000 commission, last active 45 days ago). The drawer shows his last visit was 2 months ago, he has 12 linked tenants. COO escalates to HR for a check-in call.

---

## 9. Payment Analytics

**Tab ID**: `analytics`  
**Component**: `PaymentModeAnalytics`

### What It Does

Donut pie chart showing the distribution of payment methods used across all agent collections.

### Data

- **Source**: `agent_collections` table, grouped by `payment_method`
- **Methods mapped**:
  - `mobile_money_mtn` → "MTN MoMo"
  - `mobile_money_airtel` → "Airtel Money"
  - `cash` → "Cash"
  - `wallet` → "Wallet"
  - `mobile_money` → "Mobile Money"
- **Display**: Each slice shows method name + percentage
- **Tooltip**: Shows UGX amount on hover
- **Stale time**: 10 minutes

### Case Scenario

> **Scenario**: The COO wants to understand payment preferences before launching a new payment channel. They open Analytics and see: MTN MoMo 62%, Cash 25%, Airtel 10%, Wallet 3%.
>
> **Insight**: Cash is still 25% — indicates opportunity for mobile money adoption campaigns. Airtel coverage should be expanded.

---

## 10. Financial Reports

**Tab ID**: `reports`  
**Component**: `FinancialReportsPanel`

### What It Does

One-click CSV report generation for four report types.

### Report Types

| Report | Time Range | Data Source | Columns |
|--------|------------|------------|---------|
| **Daily Revenue** | Today | `general_ledger` | Date, Reference, Category, Direction, Amount, Linked Party, Description, Account |
| **Weekly Collection** | Since Monday | `general_ledger` | Same as above |
| **Monthly Summary** | Since 1st of month | `general_ledger` | Same as above |
| **Agent Payment Report** | Last 30 days | `agent_collections` | Date, Agent ID, Tenant ID, Amount, Payment Method, Location, MoMo Provider, MoMo Phone |

### How It Works

1. User clicks the download icon next to a report
2. Data is fetched from the appropriate table with date filters
3. CSV is generated client-side
4. Browser triggers a download with the filename `{type}-{date}.csv`

### Case Scenario

> **Scenario**: End of month, the COO needs to send the CFO a summary of all financial activity. They click "Monthly Financial Summary" and receive a CSV with every ledger entry from the 1st to today. They also download the "Agent Payment Report" to cross-reference agent collections.

---

## 11. Risk & Alerts

**Tab ID**: `alerts`  
**Component**: `FinancialAlertsPanel`

### What It Does

Automated anomaly detection scanning for financial irregularities in the last 7 days.

### Alert Types

| Alert Type | Trigger | Severity | Source |
|------------|---------|----------|--------|
| **Large Payment** | `general_ledger.amount` > UGX 2,000,000 | Warning (2-5M) / Critical (>5M) | `general_ledger` |
| **Failed Withdrawal** | `withdrawal_requests.status` = 'failed' | Warning | `withdrawal_requests` |
| **Location Anomaly** | (Reserved for future) | — | — |
| **Suspicious Activity** | (Reserved for future) | — | — |

### Display

- Sorted by timestamp (newest first)
- Critical alerts: Red border, red icon
- Warning alerts: Amber border, amber icon
- Shows: Alert title, category, linked party, date
- Max height: 350px with scroll
- If no alerts: "✅ No financial anomalies detected"

### Case Scenario

> **Scenario**: The alert panel shows a critical alert: "Large payment: UGX 7,500,000 — rent repayment — John Ssemakula". The COO clicks through to Transactions, searches for the reference, and confirms it's a legitimate bulk rent pre-payment for 6 months. No action needed.
>
> **Alternative**: A "Failed withdrawal: UGX 1,200,000" alert appears. The COO investigates via Withdrawal Approvals and discovers the mobile money number was invalid. They reject the withdrawal and notify the user to update their MoMo details.

---

## 12. Withdrawal Approvals

**Tab ID**: `withdrawals`  
**Component**: `COOWithdrawalApprovals` + `COOPartnerWithdrawalApprovals`

This tab shows **two separate queues** stacked vertically:

### 12.1 User Withdrawal Approvals (COOWithdrawalApprovals)

**Title**: "Final Withdrawal Approvals (COO)"

Shows withdrawal requests that have already been approved by the CFO and are now awaiting **COO final sign-off**.

| Field | Source |
|-------|--------|
| User Name, Phone, Avatar | Joined from `profiles` |
| Amount | `withdrawal_requests.amount` |
| MoMo Provider | `mobile_money_provider` (MTN yellow / Airtel red) |
| MoMo Number | `mobile_money_number` |
| MoMo Name | `mobile_money_name` |
| CFO Approved | Time since `cfo_approved_at` |

**Filter**: `withdrawal_requests.status = 'cfo_approved'`

**Actions**:

| Action | Status Change | Next Step |
|--------|--------------|-----------|
| **Approve** | `status` → `approved`, sets `coo_approved_at`, `coo_approved_by`, `processed_by`, `processed_at` | Forwarded to Financial Ops for payment execution |
| **Reject** | `status` → `rejected`, stores `rejection_reason` | User notified of rejection |

### 12.2 Partner Withdrawal Approvals (COOPartnerWithdrawalApprovals)

**Title**: "Operations Clearance — Partner Withdrawals"

Shows investment/supporter withdrawal requests that have been approved by Partner Ops and need COO operational clearance.

| Field | Source |
|-------|--------|
| Partner Name, Phone, Avatar | Joined from `profiles` |
| Amount | `investment_withdrawal_requests.amount` |
| Reason | `reason` (quoted italic) |
| Portfolio Reviewed | Time since `partner_ops_approved_at` |
| Step Tracker | Expandable timeline showing approval progress |

**Filter**: `investment_withdrawal_requests.status = 'partner_ops_approved'`

**Actions**:

| Action | Status Change | Audit Log | Next Step |
|--------|--------------|-----------|-----------|
| **Clear** | `status` → `coo_approved`, sets `coo_approved_at`, `coo_approved_by` | `partner_withdrawal_operations_clearance_approved` | Forwarded to Treasury for payout |
| **Reject** | `status` → `rejected`, stores `rejection_reason`, `processed_by`, `processed_at` | `partner_withdrawal_operations_clearance_rejected` | Partner notified |

**Rejection requirement**: Minimum 10 characters for the reason.

### Withdrawal Approval Chain (User)

```
User requests → CFO approves → COO final approval → Financial Ops pays out
```

### Withdrawal Approval Chain (Partner)

```
Partner requests → Partner Ops reviews portfolio → COO operations clearance → Treasury payout
```

### Case Scenario

> **Scenario**: Partner Martha requests withdrawal of UGX 5,000,000 from her investment. Partner Ops verifies her portfolio can handle it and approves. The request appears in the COO's partner withdrawal queue.
>
> **COO Action**: Reviews the amount against Martha's portfolio value, sees she has UGX 12M invested. Clicks "Clear & Forward" — the request moves to Treasury for payout. An audit log is created.
>
> **Rejection Scenario**: The same request, but Martha's portfolio shows only UGX 4M invested. COO clicks "Reject" and types "Withdrawal amount exceeds portfolio value. Please submit a corrected amount." (≥10 chars required).

---

## 13. Partners

**Tab ID**: `partners`  
**Component**: `COOPartnersPage` (3,056 lines — the largest component)

### What It Does

Comprehensive partner (supporter/investor) management hub with full CRUD operations, portfolio management, bulk tools, and financial reporting.

### 13.1 Summary Cards

Top-level KPIs shown as stat cards:

| Metric | Calculation |
|--------|-------------|
| Total Partners | Count of users with `supporter` role |
| Active Partners | Partners without `frozen_at` set |
| Suspended Partners | Partners with `frozen_at` set |
| Total Funded (AUM) | Sum of all active portfolio `investment_amount` |
| Total Wallet Balance | Sum of all supporter `wallets.balance` |
| Average ROI % | Mean of all partners' `roi_percentage` |
| Total Deals | Count of active portfolios |
| Top Partner | Highest funded partner name |

### 13.2 Partner Table

Paginated table (15 per page) with search, sort, and multi-filter:

**Columns**: Name, Phone, Funded, Deals, Avg Deal, Wallet, ROI %, Payout Day, Next Payout, ROI Mode, Status, Actions

**Filters**:
- Status: All / Active / Suspended
- ROI Mode: All / Monthly Payout / Monthly Compounding
- Contact: All / Has Phone / No Phone / Has Email / No Email
- Payout Date Range: From–To date picker

**Sort**: Clickable column headers toggle asc/desc

**CSV Export**: Downloads all filtered rows

### 13.3 Partner Actions (per row)

| Action | What It Does |
|--------|--------------|
| **View Details** | Opens partner detail panel |
| **Edit Profile** | Edit name, phone, ROI %, ROI mode |
| **Invest (Proxy)** | Create a new portfolio investment on behalf of the partner |
| **Suspend** | Freeze the partner account |
| **Unsuspend** | Unfreeze (if currently suspended) |
| **Delete** | Delete partner with mandatory reason (≥10 chars), audit logged |

### 13.4 Partner Detail Panel

Clicking "View Details" loads a comprehensive partner profile:

| Section | Details |
|---------|---------|
| **Profile Header** | Name, phone, join date, suspend status |
| **Financial Summary** | Total funded, Total deals, Total ROI earned, Wallet balance |
| **Portfolios Table** | All portfolios with: Code, Name, Investment Amount, ROI %, Payout Day, Next Payout, ROI Mode, Duration, Maturity, Status |
| **Portfolio Actions** | Edit, Delete, Renew, Top-up (external), Wallet→Portfolio transfer, Change payout day, Change next payout date, Edit account name, Approve (if pending) |

### 13.5 Portfolio Management

Each portfolio supports:

| Operation | Description | Audit Logged? |
|-----------|-------------|---------------|
| **Edit Portfolio** | Change amount, ROI %, ROI mode, duration, status, contribution date | Yes |
| **Delete Portfolio** | Permanently remove (reason ≥10 chars required) | Yes |
| **Renew Portfolio** | Extend maturity, optionally adjust terms | Yes |
| **Top-up (External)** | Fund portfolio from external bank deposit | Yes |
| **Wallet → Portfolio** | Transfer from partner's wallet to portfolio | Yes |
| **Apply Pending Top-ups** | Process queued `pending_wallet_operations` | Yes |
| **Edit Payout Day** | Change day of month (1-28) | Yes |
| **Edit Next Payout Date** | Override next ROI date | Yes |
| **Edit Account Name** | Label the portfolio | Yes |
| **Approve** | Activate `pending_approval` portfolio | Yes |
| **Download PDF** | Generate and download portfolio statement |  |
| **Share via WhatsApp** | Share portfolio details via WhatsApp |  |

### 13.6 Bulk Tools

| Tool | Description |
|------|-------------|
| **Import Partners** | Upload .xlsx to bulk-create partners and portfolios |
| **Update Contribution Dates** | Upload .xlsx to bulk-update portfolio dates (handles Excel serial numbers and d-MMM-yy formats) |
| **Bulk Activate** | Approve all `pending_approval` portfolios at once |
| **Nearing Payouts** | View all portfolios sorted by days until next payout (overdue shown first) |
| **Create Portfolio** | Create a new portfolio for any existing partner |
| **Create Investment Account** | Create new investment account for a partner |

### 13.7 Key Database Tables

| Table | Role |
|-------|------|
| `profiles` | Partner identity (name, phone, frozen_at) |
| `wallets` | Partner wallet balance |
| `investor_portfolios` | Portfolio records (investment, ROI, status, dates) |
| `general_ledger` | Financial entries for portfolio creation/funding |
| `audit_logs` | All actions logged with metadata |
| `pending_wallet_operations` | Queued top-ups awaiting processing |
| `portfolio_renewals` | Renewal history per portfolio |
| `user_roles` | Role: `supporter` |

### Case Scenario

> **Scenario**: A new supporter, Grace, wants to invest UGX 10,000,000 at 20% ROI with monthly payouts. She signed up but doesn't know how to create a portfolio.
>
> **COO Action**: Opens Partners → searches "Grace" → clicks her row → "View Details" → in the detail panel, clicks "Add Portfolio" → enters: Amount: 10,000,000, ROI: 20%, Mode: Monthly Payout, Duration: 12 months, Contribution Date: today.
>
> **System Result**: A portfolio is created with code `WIP260410XXXX`, a general ledger entry records the `coo_manual_portfolio` cash_out, and an audit log captures who created it. Grace's next payout date is set to exactly one month from today.

> **Bulk Scenario**: 50 new supporters signed up through a promotion. The COO uses "Import Partners" to upload an .xlsx file with columns: Name, Phone, Amount, ROI %, Duration. All 50 get portfolios created in one action.

---

## 14. Partner Top-ups

**Tab ID**: `partner-topups`  
**Component**: `PendingPortfolioTopUps`

### What It Does

Shows pending portfolio top-up requests that need verification before being applied to the portfolio balance.

### Data

- **Source**: `pending_wallet_operations` where `operation_type = 'portfolio_topup'` AND `status = 'pending'`
- **Display**: Total pending amount, count, individual line items with description and reason
- **Limit**: 50 most recent

### What Each Top-up Shows

| Field | Description |
|-------|-------------|
| Description | Auto-generated or manual description |
| Amount | UGX value of the top-up |
| Reason | Optional metadata explaining why |

### Case Scenario

> **Scenario**: Partner John deposited UGX 2,000,000 to top up his portfolio. The deposit was recorded as a `pending_wallet_operation`. The COO sees it in the Partner Top-ups section, verifies the bank reference, and navigates to Partners → John's detail → clicks "Apply Pending Top-ups" on the relevant portfolio.
>
> **Result**: The edge function `apply-pending-topups` processes the deposit, adds UGX 2M to the portfolio's `investment_amount`, and marks the operation as `approved`.

---

## 15. Partner Financial Activity

**Tab ID**: `partner-finance`  
**Component**: `PartnerFinancialActivity`

### What It Does

Unified real-time feed of ALL partner-related financial movements across multiple data sources.

### Activity Types Tracked

| Type | Source Table | Color |
|------|-------------|-------|
| **Payout** | `pending_wallet_operations` (roi_payout) | Violet |
| **Withdrawal** | `pending_wallet_operations` (withdrawal) | Blue |
| **Top-up** | `pending_wallet_operations` (portfolio_topup) | Emerald |
| **Retraction** | `pending_wallet_operations` (retraction) | Red |
| **Deposit** | `pending_wallet_operations` (deposit) | Amber |

### Columns

Type, Partner Name, Amount, Status, Date, Reference, Description

### Real-time

Subscribes to Postgres changes on:
- `pending_wallet_operations` → auto-refreshes
- `wallet_deductions` → auto-refreshes

### Case Scenario

> **Scenario**: The COO needs to audit all partner financial activity for the day. They open Partner Finance and see a chronological stream: 3 payouts processed, 1 top-up pending, 1 withdrawal rejected, 2 deposits confirmed. They can filter by type or search by partner name.

---

## 16. Staff Performance

**Tab ID**: `staff-performance`  
**Component**: `StaffPerformancePanel`

### What It Does

Tracks internal staff productivity over the last 30 days using audit logs.

### Metrics Per Staff Member

| Metric | Source |
|--------|--------|
| Total Actions | Count of `audit_logs` entries |
| Last Active | Most recent `audit_logs.created_at` |
| Avg Response (hrs) | Calculated from action timestamps |
| Deposits Processed | Count of deposit-related actions |
| Payouts Processed | Count of payout-related actions |
| Withdrawals Processed | Count of withdrawal-related actions |

### Staff Roles Tracked

`manager`, `super_admin`, `employee`, `operations`, `ceo`, `coo`, `cfo`, `cto`, `cmo`, `crm`

### Case Scenario

> **Scenario**: The CEO asks the COO which staff members processed the most withdrawals this month. The COO opens Staff Performance and sorts by "Withdrawals Processed". They see Financial Ops team member Alice processed 147 withdrawals while Bob processed only 23.
>
> **Insight**: Bob may need retraining or may have been on leave. COO checks with HR.

---

## 17. Approval Workflows & Chains

### Rent Request Pipeline

```
Tenant submits rent request
    ↓
[1] Tenant Ops → Reviews, assigns agent → tenant_ops_approved
    ↓
[2] Agent → Verifies on-site → agent_verified
    ↓
[3] Landlord Ops → Validates landlord → landlord_ops_approved
    ↓
[4] ★ COO → Operational sign-off → coo_approved
    ↓
[5] CFO → Authorizes payout → funded
    ↓
Agent float is topped up, agent pays landlord
```

### User Withdrawal Pipeline

```
User requests withdrawal
    ↓
CFO reviews & approves → cfo_approved
    ↓
★ COO final approval → approved
    ↓
Financial Ops executes MoMo payment
```

### Partner Withdrawal Pipeline

```
Partner requests investment withdrawal
    ↓
Partner Ops reviews portfolio → partner_ops_approved
    ↓
★ COO operations clearance → coo_approved
    ↓
Treasury executes payout
```

### Portfolio Top-up Pipeline

```
Partner deposits money (bank/MoMo)
    ↓
Recorded as pending_wallet_operation (portfolio_topup, pending)
    ↓
★ COO/Ops verifies → Apply Pending Top-ups
    ↓
Edge function processes: investment_amount += top-up, status → approved
```

---

## 18. Database Tables & Backend

### Core Tables Used by COO Dashboard

| Table | Primary Use in COO |
|-------|-------------------|
| `rent_requests` | Rent approval queue (stage filtering) |
| `general_ledger` | Financial metrics, transactions, reports, alerts |
| `withdrawal_requests` | User withdrawal approvals |
| `investment_withdrawal_requests` | Partner withdrawal approvals |
| `agent_collections` | Agent collection performance, payment analytics |
| `agent_visits` | Agent activity tracking |
| `wallets` | System wallet balance, per-user balance |
| `profiles` | User identity for all views |
| `user_roles` | Role-based filtering (agent, supporter) |
| `investor_portfolios` | Partner portfolio management |
| `pending_wallet_operations` | Top-ups, payouts, retractions, deposits |
| `audit_logs` | Staff performance, action auditing |
| `agent_earnings` | Agent commission tracking |
| `agent_landlord_assignments` | Agent-landlord relationships |
| `agent_float_limits` | Agent float monitoring |
| `portfolio_renewals` | Portfolio renewal history |
| `wallet_deductions` | Partner wallet deduction tracking |

### RPC Functions

| RPC | Used By | Purpose |
|-----|---------|---------|
| `get_paginated_transactions` | Transactions tab | Server-side paginated ledger query |
| `get_agents_hub` | Agent Hub | Server-side agent aggregation with search/sort/pagination |

### Edge Functions

| Function | Used By | Purpose |
|----------|---------|---------|
| `apply-pending-topups` | Partner detail | Process queued portfolio top-ups |

### Data Caching Strategy

| Component | Stale Time | Rationale |
|-----------|------------|-----------|
| Financial Metrics | 5 min | Balance between freshness and load |
| Transactions | 2 min | Users expect near-real-time data |
| Agent Collections | 5 min | Daily overview, not real-time |
| Payment Analytics | 10 min | Changes slowly |
| Alerts | 5 min | Anomalies don't change rapidly |
| Partner data | On-demand | Fetches on mount, refreshes after mutations |
| Staff Performance | 10 min | Historical data, low urgency |
| Agent Hub | On-demand | Paginated, refreshes on filter change |

---

## 19. Case Scenarios

### Scenario 1: End-of-Day COO Review

**Context**: It's 6 PM and the COO does their daily review.

1. **Open Overview** — Check Financial Metrics: Payments Today UGX 15.2M, 3 Pending Approvals, 0 Failed.
2. **Check Rent Approvals** — 2 requests from Landlord Ops. Both look good. Approve both → forwarded to CFO.
3. **Check Withdrawals** — 1 user withdrawal (UGX 800K, CFO approved). MoMo number matches profile. Approve → Financial Ops will pay.
4. **Check Alerts** — 1 large payment alert (UGX 3M). Verified as a legitimate bulk payment. No action needed.
5. **Download Reports** — Download Daily Revenue Report CSV and email to CFO.

### Scenario 2: New Partner Onboarding

**Context**: 10 new supporters need portfolios created from an Excel sheet.

1. **Open Partners** → Click "Import Partners" button
2. **Upload .xlsx** with columns: Name, Phone, Amount, ROI %, Duration
3. **Preview** the import — verify names and amounts match
4. **Confirm** → System creates profiles, wallets, and portfolios
5. **Verify** — Each appears in the Partners table with "Active" status
6. **If dates are wrong** — Use "Update Contribution Dates" to bulk-fix via another .xlsx

### Scenario 3: Agent Performance Investigation

**Context**: Reports of an agent not collecting rent for 2 weeks.

1. **Open Agent Hub** → Click "At Risk" filter
2. **Search** agent name → Click their row
3. **Agent Detail Drawer** opens:
   - Last visit: 16 days ago
   - 0 collections this month
   - Wallet balance: UGX 45,000 (low)
   - 8 linked tenants who haven't paid
4. **Action**: COO notes the findings, opens Staff Performance to check if the agent's supervisor has been logging follow-ups
5. **Escalation**: COO contacts HR for a formal performance review

### Scenario 4: Partner Portfolio Dispute

**Context**: A partner claims their ROI rate was supposed to be 25% but it shows 20%.

1. **Open Partners** → Search partner name → "View Details"
2. **Portfolio table** shows: ROI 20%, created 3 months ago
3. **Check audit log**: Find `create_manual_portfolio` entry with original metadata showing `roi_percentage: 20`
4. **Resolution**: The original agreement was indeed 20%. Show the partner the audit trail. If an error is confirmed, COO can click "Edit" on the portfolio and change ROI to 25%.
5. **Audit**: The edit is logged with before/after values.

### Scenario 5: Reconciliation Discrepancy

**Context**: CFO reports UGX 500K missing from yesterday's reconciliation.

1. **Open Transactions** → Filter: Yesterday, Direction: Cash Out
2. **Search** for suspicious entries → Find a `cash_out` entry with no linked party
3. **Cross-reference** → Open Wallets → Audit Trail → Find the action
4. **Discovery**: A wallet deduction was made without proper documentation
5. **Action**: COO flags the staff member, requests explanation, and if unauthorized, initiates disciplinary process via HR dashboard

---

## Appendix: Component File Map

| Component File | Used In | Lines |
|----------------|---------|-------|
| `src/pages/coo/Dashboard.tsx` | Main page | 247 |
| `src/components/coo/FinancialMetricsCards.tsx` | Overview | 97 |
| `src/components/coo/FinancialTransactionsTable.tsx` | Transactions | 185 |
| `src/components/coo/AgentCollectionsOverview.tsx` | Collections | 118 |
| `src/components/coo/COOAgentHub.tsx` | Agent Hub | 326 |
| `src/components/coo/AgentDetailDrawer.tsx` | Agent detail | 177 |
| `src/components/coo/PaymentModeAnalytics.tsx` | Analytics | 88 |
| `src/components/coo/FinancialReportsPanel.tsx` | Reports | 114 |
| `src/components/coo/FinancialAlertsPanel.tsx` | Alerts | 120 |
| `src/components/coo/COOWithdrawalApprovals.tsx` | Withdrawals | 285 |
| `src/components/coo/COOPartnerWithdrawalApprovals.tsx` | Withdrawals | 298 |
| `src/components/coo/COOPartnersPage.tsx` | Partners | 3,056 |
| `src/components/coo/PartnerImportDialog.tsx` | Partner import | 530 |
| `src/components/coo/UpdateContributionDatesDialog.tsx` | Date updates | 322 |
| `src/components/coo/WalletMonitoringPanel.tsx` | Wallet monitoring | 72 |
| `src/components/financial-ops/FinancialOpsCommandCenter.tsx` | Wallets tab | 191 |
| `src/components/executive/RentPipelineQueue.tsx` | Rent approvals | 823 |
| `src/components/executive/StaffPerformancePanel.tsx` | Staff metrics | 352 |
| `src/components/executive/PartnerFinancialActivity.tsx` | Partner finance | 219 |
| `src/components/cfo/PendingPortfolioTopUps.tsx` | Partner top-ups | 75 |
| `src/components/shared/ShareSupporterRecruit.tsx` | Recruit button | 129 |

---

*End of COO Dashboard Documentation v2.0*

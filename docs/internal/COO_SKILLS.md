# COO Dashboard — Partner Management Skills Reference

> **Version**: 1.0 | **Last Updated**: 2026-03-27
> **Audience**: Engineers building or extending the COO Dashboard's Partner Management module.
> **Source of Truth**: `src/components/coo/COOPartnersPage.tsx` (2,190 lines), `src/pages/coo/Dashboard.tsx`, `supabase/functions/coo-invest-for-partner/index.ts`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Partner Directory & Table Management](#2-partner-directory--table-management)
3. [Partner Detail View](#3-partner-detail-view)
4. [Portfolio CRUD Operations](#4-portfolio-crud-operations)
5. [Proxy Investment (Wallet → Pool)](#5-proxy-investment-wallet--pool)
6. [Wallet → Portfolio Transfer](#6-wallet--portfolio-transfer)
7. [Partner Import (Bulk Excel)](#7-partner-import-bulk-excel)
8. [Portfolio Approval & Activation](#8-portfolio-approval--activation)
9. [Partner Lifecycle Management](#9-partner-lifecycle-management)
10. [Portfolio Renewals & Top-Ups](#10-portfolio-renewals--top-ups)
11. [PDF Generation & WhatsApp Sharing](#11-pdf-generation--whatsapp-sharing)
12. [Data Fetching & Performance](#12-data-fetching--performance)
13. [Daily Partners Brief (Ops KPI)](#13-daily-partners-brief-ops-kpi)
14. [Audit Logging](#14-audit-logging)
15. [Database Tables & Relationships](#15-database-tables--relationships)
16. [Edge Functions](#16-edge-functions)

---

## 1. Architecture Overview

### Component Hierarchy

```
COODashboardPage (src/pages/coo/Dashboard.tsx)
  └─ Quick Nav Card: "Partners" → activeTab = 'partners'
      └─ COOPartnersPage (src/components/coo/COOPartnersPage.tsx)
          ├─ Summary Cards (4 KPIs)
          ├─ Filter Bar (search, status, ROI mode, import, bulk activate, export)
          ├─ Partner Table (paginated, sortable, filterable)
          ├─ Partner Detail Dialog (profile + portfolio cards)
          ├─ Add Portfolio Dialog
          ├─ Edit Portfolio Dialog
          ├─ Delete Portfolio Dialog
          ├─ Invest Dialog (proxy investment)
          ├─ Wallet → Portfolio Transfer Dialog
          ├─ Suspend/Reactivate Confirm Dialog
          ├─ Delete Partner Confirm Dialog
          ├─ Edit Partner Dialog
          ├─ RenewPortfolioDialog (imported component)
          ├─ FundInvestmentAccountDialog (imported component)
          └─ PartnerImportDialog (src/components/coo/PartnerImportDialog.tsx)
```

### Key Design Principles

- **Mobile-first**: All dialogs, tables, and cards are smartphone-optimized with `min-h-[44px]` touch targets.
- **Optimistic locking**: Wallet deductions use `WHERE balance = $previousBalance` to prevent double-spending.
- **Audit-everything**: Every mutation (edit, delete, create, suspend, invest) logs to `audit_logs`.
- **Batched queries**: Uses `fetchAllUserIdsByRole()` + `batchedQuery()` for supporter lists (chunks of 50 IDs).
- **Dual-ID resolution**: Portfolios link to supporters via both `investor_id` and `agent_id`; queries always check both.

---

## 2. Partner Directory & Table Management

### Data Source

Partners are derived from **all users with the `supporter` role** in `user_roles`. The system aggregates portfolio data, wallet balances, and profile info.

### Table Schema (PartnerRow)

| Field | Type | Source |
|---|---|---|
| `id` | UUID | `user_roles.user_id` |
| `name` | string | `profiles.full_name` |
| `phone` | string | `profiles.phone` |
| `funded` | number | Sum of `investor_portfolios.investment_amount` (active/pending) |
| `activeDeals` | number | Count of active/pending portfolios |
| `avgDeal` | number | `funded / activeDeals` |
| `walletBalance` | number | `wallets.balance` |
| `roiPercentage` | number | Most recent portfolio's `roi_percentage` |
| `payoutDay` | number | Most recent portfolio's `payout_day` |
| `roiMode` | string | `monthly_payout` or `monthly_compounding` |
| `status` | string | `active` (default) or `suspended` (if `profiles.frozen_at` is set) |
| `joinedAt` | string | `profiles.created_at` |
| `lastActivity` | string | Most recent portfolio `created_at` |

### Filtering & Sorting

- **Search**: Name or phone (case-insensitive, in-memory).
- **Status filter**: All / Active / Suspended.
- **ROI Mode filter**: All / Payout / Compounding.
- **Sort**: Click any column header → asc → desc → none. Default: `funded` desc.
- **Pagination**: 15 rows per page with prev/next buttons.
- **Export**: CSV download of all filtered rows.

### Row Actions (Dropdown Menu)

| Action | Icon | Condition | Effect |
|---|---|---|---|
| Edit Partner | Pencil | Always | Opens edit dialog (name, phone, ROI, mode) |
| Invest | TrendingUp | `walletBalance ≥ 50,000` AND not suspended | Opens invest dialog |
| Suspend / Reactivate | Ban / PlayCircle | Always | Toggles `profiles.frozen_at` |
| Delete Partner | Trash2 | Always | Removes `supporter` role + freezes profile |

---

## 3. Partner Detail View

Clicking a partner name opens a **full-screen dialog** with:

### Header Section
- Large avatar initial (first letter of name)
- Full name, phone, join date
- Status badge (Active/Suspended)
- Frozen reason (if applicable)
- Call and WhatsApp buttons

### KPI Grid (4 cards)
- **Wallet Balance**: Current `wallets.balance`
- **Total Funded**: Sum of portfolio `investment_amount` (falls back to ledger `cash_out` totals)
- **Active Deals**: Portfolio count (falls back to ledger deal count)
- **Total ROI Earned**: Sum of `investor_portfolios.total_roi_earned`

### Portfolio Cards
Each portfolio renders as a card showing:
- Portfolio code and optional account name (inline editable)
- Investment amount, ROI %, ROI mode badge
- Duration, maturity date, created date
- Next payout date calculation
- Status indicator (Active / Pending Approval / Pending)
- Payout day (inline editable with save button)
- Renewal count badge

### Portfolio Action Buttons
| Button | Condition | Description |
|---|---|---|
| Approve | Status = `pending_approval` or `pending` | Activates the portfolio |
| Edit | Always | Opens full edit dialog |
| Top Up | Status = `active` | Opens FundInvestmentAccountDialog |
| Wallet → Portfolio | Active + wallet balance > 0 | Transfers wallet funds to portfolio |
| Apply Pending | Has pending top-ups | Processes queued deposits |
| Renew | Always | Opens RenewPortfolioDialog |
| Delete | Always | Requires 10+ char reason |
| PDF | Always | Downloads portfolio summary PDF |
| WhatsApp | Always | Shares portfolio via WhatsApp |

### Bottom Actions
- **Add New Portfolio** button (opens creation dialog)

---

## 4. Portfolio CRUD Operations

### Create Portfolio (Manual)

**Dialog fields**: Amount, ROI %, Duration (months), ROI Mode, Payout Day (1-28), Contribution Date (optional, for backdating).

**Logic**:
1. Generate portfolio code: `WIP{YYMMDD}{4-digit-random}`
2. Generate 4-digit PIN and activation token (UUID)
3. Calculate `maturity_date = created_at + duration_months`
4. Calculate `next_roi_date = created_at + 1 month`, set day to `payout_day`
5. Insert into `investor_portfolios` with `investor_id = agent_id = partner_id`
6. Insert ledger entry: category `coo_manual_portfolio`, direction `cash_out`
7. Insert audit log: action `create_manual_portfolio`

**Quick amount buttons**: 500K, 1M, 2M, 5M, 10M

### Edit Portfolio

**Editable fields**: Amount, ROI %, ROI Mode, Duration, Status, Invested-On Date.

**Status options**: `active`, `pending`, `pending_approval`, `matured`, `cancelled`

**Logic**:
1. Log full before/after diff to `audit_logs` (action `edit_investment_portfolio`)
2. Update `investor_portfolios` record
3. Update local state optimistically

### Delete Portfolio

**Requirements**: Minimum 10-character reason.

**Logic**:
1. Insert audit log with full portfolio snapshot + reason (action `delete_investment_portfolio`)
2. Delete from `investor_portfolios`
3. Show toast with portfolio code confirmation

---

## 5. Proxy Investment (Wallet → Pool)

**Edge Function**: `coo-invest-for-partner`

### Flow
1. COO selects partner → "Invest" → enters amount
2. Client-side validation: `amount ≥ 50,000` AND `amount ≤ walletBalance`
3. Edge function:
   - Authenticates caller (must have `manager` role)
   - Validates partner has `supporter` role
   - Deducts from partner's wallet (**optimistic locking**: `WHERE balance = $previous`)
   - Creates double-entry ledger:
     - DEBIT: `coo_proxy_investment` / `cash_out` on partner
     - CREDIT: `pool_capital_received` / `cash_in` on null (platform)
   - Creates `investor_portfolios` record (status `active`, 12-month duration, 15% ROI)
   - Sends notification to partner
4. On failure: wallet balance is rolled back

### Response
```json
{
  "success": true,
  "reference_id": "WCI2603271234",
  "new_balance": 3500000,
  "payout_day": 27,
  "first_payout_date": "2026-04-26",
  "monthly_reward": 75000,
  "partner_name": "Benjamin Kato"
}
```

---

## 6. Wallet → Portfolio Transfer

Transfers funds from a partner's wallet directly into an **existing active portfolio**.

### Flow
1. COO opens partner detail → clicks "Wallet → Portfolio" on a portfolio card
2. Enters amount (min 1,000, max = wallet balance) and reason (min 10 chars)
3. System calls `wallet-to-portfolio-transfer` edge function
4. Uses optimistic locking for wallet deduction
5. Records `pending_portfolio_topup` operation
6. Audit-logged

### Validations
- Amount: `≥ 1,000` and `≤ walletBalance`
- Reason: `≥ 10 characters`
- Portfolio must be `active`

---

## 7. Partner Import (Bulk Excel)

**Component**: `PartnerImportDialog` (573 lines)

### Import Steps

| Step | Name | Description |
|---|---|---|
| 1 | Upload | Drag-and-drop or click to browse `.xlsx` files (max 500 rows) |
| 2 | Preview | Shows parsed groups with validation status |
| 3 | Confirm | Final review before processing |
| 4 | Processing | Shows spinner while edge function runs |
| 5 | Results | Summary of created/skipped/errored records |

### Column Headers (Flexible Aliases)

| Canonical | Accepted Aliases |
|---|---|
| Partner Name | Supporter Name, Name, Full Name |
| Phone | Phone Number, Mobile, Tel |
| Email | Email Address, E-mail |
| Investment Amount | Principal (UGX), Principal, Amount |
| ROI % | Rate, Interest Rate, ROI Percentage |
| Duration (Months) | Duration, Months, Term, Period |
| ROI Mode | Mode, Payout Mode, ROI Type |
| Contribution Date | Date, Investment Date, Start Date |

### Grouping Logic
Partners are grouped by: **Phone first** → **Email second** → **Row ID fallback**.

Multiple rows with the same phone number are combined into one partner with multiple portfolios.

### Validation Rules
- Partner name: required
- Phone: 10+ digits or blank
- Amount: ≥ 50,000 UGX
- ROI: 1–30%
- Duration: 1–36 months
- ROI Mode: `monthly_payout` or `monthly_compounding`
- Contribution Date: Accepts ISO, US (M/D/YYYY), EU (DD-MM-YYYY), and Excel serial dates

### Phone Normalization
- `+256XXXXXXXXX` → `0XXXXXXXXX`
- `256XXXXXXXXX` → `0XXXXXXXXX`
- Strips spaces, hyphens, plus signs

### Duplicate Detection
- Client-side: Checks existing `profiles.phone` for matches
- Server-side (edge function): Email dedup handled during account creation
- Existing partners: Marked with amber badge, portfolios added to existing account

### Edge Function
`import-partners`: Creates auth accounts (password `Welile1234!`), profiles, wallets, supporter roles, and portfolios in batch.

---

## 8. Portfolio Approval & Activation

### Single Approve
1. Updates `investor_portfolios.status` from `pending_approval` → `active`
2. Also approves linked `pending_wallet_operations` (status `pending` → `approved`)
3. Audit-logged (action `approve_portfolio`)

### Bulk Activate
1. Button appears in filter bar when `pendingApprovalCount > 0`
2. Shows confirmation dialog
3. Batch updates ALL `pending_approval` portfolios to `active`
4. Toast shows count of activated portfolios

---

## 9. Partner Lifecycle Management

### Edit Partner
- **Fields**: Name, Phone, ROI %, ROI Mode
- **Effect**: Updates `profiles` AND all active/pending `investor_portfolios`
- **Orphan Repair**: If no portfolio exists but ledger entries do, auto-creates a portfolio from ledger data

### Suspend Partner
- Sets `profiles.frozen_at` to current timestamp
- Sets `profiles.frozen_reason` to "Suspended by COO"
- Partner appears dimmed (opacity-60) in table
- Reversible: "Reactivate" clears `frozen_at` and `frozen_reason`

### Delete Partner (Permanent)
- Requires 10+ character reason
- Removes `supporter` role from `user_roles`
- Freezes profile with deletion reason
- Audit-logged (action `partner_deleted`)
- **Does NOT delete**: wallet, ledger entries, or portfolios (for audit trail)

---

## 10. Portfolio Renewals & Top-Ups

### Renewals
- Uses `RenewPortfolioDialog` component
- Tracks renewal count per portfolio via `portfolio_renewals` table
- Displays renewal badge (×1, ×2, etc.) on portfolio card

### External Top-Up (Deposit)
- Uses `FundInvestmentAccountDialog` component
- Creates a pending wallet operation for external fund sourcing

### Apply Pending Top-Ups
- Calls `apply-pending-topups` edge function
- Processes all queued deposits for a specific portfolio
- Updates `investment_amount` with total applied
- Shows toast with count and new capital total

---

## 11. PDF Generation & WhatsApp Sharing

### Portfolio PDF
- Uses `downloadPortfolioPdf()` from `src/lib/portfolioPdf.ts`
- Includes: portfolio code, account name, amount, ROI %, mode, status, dates, owner name

### WhatsApp Share
- Uses `sharePortfolioViaWhatsApp()` from `src/lib/portfolioPdf.ts`
- Opens WhatsApp with pre-formatted portfolio summary message

---

## 12. Data Fetching & Performance

### Batched Query Pattern
```typescript
const supporterIds = await fetchAllUserIdsByRole('supporter');
const [profiles, wallets, portfolios] = await Promise.all([
  batchedQuery(ids, (batch) => supabase.from('profiles').select('...').in('id', batch)),
  batchedQuery(ids, (batch) => supabase.from('wallets').select('...').in('user_id', batch)),
  batchedQuery(ids, (batch) => supabase.from('investor_portfolios').select('...')
    .or(`investor_id.in.(${batch.join(',')}),agent_id.in.(${batch.join(',')})`)),
]);
```

### Why Batching?
- Supabase has a 1,000-row default limit per query
- `batchedQuery` splits ID lists into chunks of 50
- `fetchAllUserIdsByRole` uses recursive pagination to get ALL supporter IDs

### Caching
- `PartnerOpsBrief`: `staleTime: 300000` (5 minutes)
- `COOPartnersPage`: No React Query (manual fetch with `useCallback`)
- Manual refresh button available

---

## 13. Daily Partners Brief (Ops KPI)

**Component**: `PartnerOpsBrief` (used in Executive Hub's Partners Ops dashboard)

### KPIs (5 metrics, grid layout)

| Metric | Query | Color Logic |
|---|---|---|
| New Portfolios (24h) | `investor_portfolios` created in last 24h | Always blue |
| Pending Approval | `investor_portfolios` with status `pending_approval` | Amber if > 0 |
| Maturing in 7 days | Active portfolios with `maturity_date` ≤ 7 days from now | Orange if > 0 |
| ROI Paid (24h) | `supporter_roi_payments` paid in last 24h | Always green |
| Open Escalations | `partner_escalations` with status `open` | Red if > 0 |

---

## 14. Audit Logging

Every partner-related action creates an `audit_logs` entry:

| Action Type | Table | Context |
|---|---|---|
| `approve_portfolio` | `investor_portfolios` | Portfolio ID, approved individually |
| `edit_portfolio_name` | `investor_portfolios` | New name |
| `edit_investment_portfolio` | `investor_portfolios` | Full before/after diff |
| `delete_investment_portfolio` | `investor_portfolios` | Full snapshot + reason |
| `create_manual_portfolio` | `investor_portfolios` | All creation params |
| `partner_deleted` | `user_roles` | Partner name + reason |
| `partner_suspended` | `user_roles` | Partner name + reason |

---

## 15. Database Tables & Relationships

### Core Tables

| Table | Purpose |
|---|---|
| `user_roles` | Links users to `supporter` role |
| `profiles` | Name, phone, frozen status |
| `wallets` | Balance per user |
| `investor_portfolios` | Portfolio records (investment amount, ROI config, status) |
| `general_ledger` | Financial transaction history (double-entry) |
| `portfolio_renewals` | Tracks renewal events per portfolio |
| `pending_wallet_operations` | Queued deposits/top-ups awaiting approval |
| `supporter_roi_payments` | ROI payment records |
| `partner_escalations` | Issue tracking for partners |
| `audit_logs` | Immutable action history |
| `notifications` | In-app notifications sent to partners |

### Portfolio Status Lifecycle

```
pending_approval → active → matured
                 → cancelled
pending → active → matured
```

---

## 16. Edge Functions

| Function | Purpose | Auth |
|---|---|---|
| `coo-invest-for-partner` | Proxy investment from partner wallet | Manager role required |
| `import-partners` | Bulk import from Excel data | Manager role required |
| `apply-pending-topups` | Process queued deposits into portfolio | Authenticated |
| `supporter-account-action` | Self-service renewal/withdrawal | Portfolio owner |
| `wallet-to-portfolio-transfer` | Move wallet funds to portfolio | Manager role required |
| `delete-user` | Full account deletion | Manager role required |

---

## Quick Reference: Constants

```typescript
const MIN_INVEST = 50_000;           // Minimum investment amount (UGX)
const PAGE_SIZE = 15;                 // Partners per page
const VALID_ROI_MODES = ['monthly_payout', 'monthly_compounding'];
const DEFAULT_ROI = 15;               // Default ROI percentage
const DEFAULT_PAYOUT_DAY = 15;        // Default day of month for payouts
const DEFAULT_DURATION = 12;          // Default portfolio duration (months)
const DEFAULT_IMPORT_PASSWORD = 'Welile1234!';  // Import account password
const MAX_IMPORT_ROWS = 500;          // Excel import row limit
const BATCH_SIZE = 50;                // Query batch chunk size
```

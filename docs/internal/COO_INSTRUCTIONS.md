# COO Dashboard — Partner Operations: Flow & Logic Instructions

> **Version**: 1.0 | **Last Updated**: 2026-03-27
> **Purpose**: Step-by-step instructions for every partner-related flow in the COO Dashboard, with examples.
> **Audience**: Engineers implementing or extending the COO Partner Operations module.

---

## Table of Contents

1. [Navigation to Partner Management](#1-navigation-to-partner-management)
2. [Loading the Partner Directory](#2-loading-the-partner-directory)
3. [Searching & Filtering Partners](#3-searching--filtering-partners)
4. [Viewing Partner Details](#4-viewing-partner-details)
5. [Proxy Investment Flow](#5-proxy-investment-flow)
6. [Creating a Manual Portfolio](#6-creating-a-manual-portfolio)
7. [Editing a Portfolio](#7-editing-a-portfolio)
8. [Deleting a Portfolio](#8-deleting-a-portfolio)
9. [Approving Portfolios](#9-approving-portfolios)
10. [Wallet → Portfolio Transfer Flow](#10-wallet--portfolio-transfer-flow)
11. [External Top-Up (Fund Portfolio)](#11-external-top-up-fund-portfolio)
12. [Applying Pending Top-Ups](#12-applying-pending-top-ups)
13. [Renewing a Portfolio](#13-renewing-a-portfolio)
14. [Editing a Partner Profile](#14-editing-a-partner-profile)
15. [Suspending & Reactivating a Partner](#15-suspending--reactivating-a-partner)
16. [Deleting a Partner](#16-deleting-a-partner)
17. [Bulk Import Partners from Excel](#17-bulk-import-partners-from-excel)
18. [Bulk Activate Pending Portfolios](#18-bulk-activate-pending-portfolios)
19. [Exporting Partner Data](#19-exporting-partner-data)
20. [Portfolio PDF & WhatsApp Sharing](#20-portfolio-pdf--whatsapp-sharing)
21. [Editing Portfolio Payout Day (Inline)](#21-editing-portfolio-payout-day-inline)
22. [Editing Portfolio Account Name (Inline)](#22-editing-portfolio-account-name-inline)
23. [Orphan Portfolio Repair](#23-orphan-portfolio-repair)
24. [Error Handling & Rollback Patterns](#24-error-handling--rollback-patterns)
25. [Security & Access Control](#25-security--access-control)

---

## 1. Navigation to Partner Management

### Route
COO Dashboard lives at `/coo/dashboard`. Partners tab is an internal state, not a separate route.

### Flow
1. User clicks the **"Partners"** card on the COO overview grid (indigo-colored, Handshake icon)
2. `activeTab` state changes to `'partners'`
3. `renderContent()` switch renders `<COOPartnersPage />`
4. A "Back to Overview" button appears (mobile only) to return to the grid

### Example
```
User taps "Partners" card
→ handleNavTo('partners')
→ setActiveTab('partners')
→ window.scrollTo({ top: 0 })
→ COOPartnersPage renders
```

---

## 2. Loading the Partner Directory

### Flow
1. Component mounts → `fetchData()` is called
2. `fetchAllUserIdsByRole('supporter')` retrieves ALL user IDs with the supporter role
3. Three parallel batched queries fire:
   - `profiles` (name, phone, created_at, frozen_at)
   - `wallets` (user_id, balance)
   - `investor_portfolios` (active/pending, ordered by created_at desc)
4. Portfolios are aggregated per supporter:
   - Total funded = sum of `investment_amount`
   - Deal count = number of portfolios
   - ROI info = from most recent portfolio
5. Rows are filtered to only show partners with `funded > 0` OR `activeDeals > 0`
6. Summary KPIs are calculated (total partners, active count, suspended, total funded, wallet totals, avg ROI)

### Example: 200 supporters
```
fetchAllUserIdsByRole('supporter') → [id1, id2, ..., id200]
batchedQuery splits into 4 batches of 50
Each batch runs: profiles.in('id', batch), wallets.in('user_id', batch), portfolios.or(...)
Results merged → 200 PartnerRow objects created
Filtered: 150 have portfolios → table shows 150 rows
Summary: { totalPartners: 150, activePartners: 142, suspendedPartners: 8, ... }
```

### Dual-ID Resolution
Portfolios can link to supporters via `investor_id` OR `agent_id`. The query uses:
```sql
investor_id.in.(batch) OR agent_id.in.(batch)
```
Then ownership is determined:
```typescript
const ownerId = p.investor_id && supporterIdSet.has(p.investor_id)
  ? p.investor_id
  : p.agent_id && supporterIdSet.has(p.agent_id)
    ? p.agent_id
    : null;
```

---

## 3. Searching & Filtering Partners

### Search
- Input field with magnifying glass icon
- Filters in-memory: `name.toLowerCase().includes(query)` OR `phone.includes(query)`
- Clears with X button
- Resets page to 0 on change

### Status Filter
- Dropdown: All / Active / Suspended
- Suspended = `profiles.frozen_at IS NOT NULL`

### ROI Mode Filter
- Dropdown: All / Payout / Compounding
- Matches `roiMode` field

### Sorting
- Click column header → ascending → descending → clear
- Numeric columns: numeric comparison
- String columns: `localeCompare`
- Null values sort to end

### Example
```
User types "0780" in search
→ 200 rows filtered to 3 matching phone numbers
→ Page resets to 0
→ Footer shows "3 of 150 (filtered)"
```

---

## 4. Viewing Partner Details

### Flow
1. Click partner name in table → `openPartnerDetail(partnerId)`
2. Dialog opens with loading spinner
3. Four parallel queries fire:
   - Profile (with `frozen_at`, `frozen_reason`)
   - Wallet balance
   - All portfolios (any status, ordered by created_at desc)
   - Ledger entries (categories: `supporter_rent_fund`, `supporter_facilitation_capital`, `coo_proxy_investment`)
4. For each portfolio, fetch renewal counts and pending top-ups
5. Total funded uses ledger data if available, falls back to portfolio sum

### Example
```
Click "Benjamin Kato"
→ openPartnerDetail('abc-123-def')
→ Profile: { full_name: "Benjamin Kato", phone: "0780790585", frozen_at: null }
→ Wallet: 1,500,000 UGX
→ Portfolios: [
    { code: "WCI260327xxxx", amount: 500,000, roi: 15%, status: "active" },
    { code: "WCI260320xxxx", amount: 2,000,000, roi: 15%, status: "active" }
  ]
→ Ledger funded: 2,500,000 (2 cash_out entries)
→ KPIs: Wallet=1.5M, Funded=2.5M, Deals=2, ROI Earned=375K
```

---

## 5. Proxy Investment Flow

### Purpose
COO invests money FROM a partner's wallet INTO the Rent Management Pool, creating a new portfolio.

### Preconditions
- Partner wallet balance ≥ 50,000 UGX
- Partner is not suspended
- COO has `manager` role

### Step-by-Step

1. **COO opens Invest dialog** (via dropdown menu or detail view)
2. **Enters amount** — Quick buttons: 500K, 1M, 2M, 5M. Or custom amount.
3. **Client validation**:
   - `amount ≥ 50,000`
   - `amount ≤ walletBalance`
4. **Edge function `coo-invest-for-partner`** is called with `{ partner_id, amount }`
5. **Server-side flow**:
   a. Authenticate caller → verify `manager` role
   b. Verify partner has `supporter` role
   c. Check partner wallet balance
   d. **Optimistic lock deduction**: `UPDATE wallets SET balance = balance - amount WHERE user_id = partner_id AND balance = $previousBalance`
   e. If lock fails → return 409 (concurrent update)
   f. Generate reference: `WCI{YYMMDD}{4-digit-random}` (e.g., `WCI2603271234`)
   g. Generate transaction group UUID
   h. Calculate `first_payout_date = now + 30 days`
   i. Calculate `maturity_date = now + 12 months`
   j. Insert DEBIT ledger entry (partner `cash_out`, category `coo_proxy_investment`)
   k. Insert CREDIT ledger entry (pool `cash_in`, category `pool_capital_received`)
   l. **If DEBIT fails**: ROLLBACK wallet to previous balance
   m. Create `investor_portfolios` record (status `active`, ROI 15%, 12 months)
   n. Send notification to partner
6. **Client receives response** with reference_id, new_balance, first_payout_date
7. **Toast**: "Invested UGX 500,000 for Benjamin Kato — Ref: WCI2603271234"
8. **Table refreshes**

### Example Ledger Entries

**DEBIT (Partner)**:
```json
{
  "user_id": "abc-123",
  "amount": 500000,
  "direction": "cash_out",
  "category": "coo_proxy_investment",
  "description": "Welile Operations invested UGX 500,000 from Benjamin Kato's wallet into Rent Management Pool. Payout day: 27th. First payout: 2026-04-26",
  "linked_party": "Rent Management Pool",
  "transaction_group_id": "uuid-txg-001"
}
```

**CREDIT (Pool)**:
```json
{
  "user_id": null,
  "amount": 500000,
  "direction": "cash_in",
  "category": "pool_capital_received",
  "description": "Rent Management Pool received UGX 500,000 from Benjamin Kato (facilitated by Welile Operations)",
  "linked_party": "Benjamin Kato",
  "transaction_group_id": "uuid-txg-001"
}
```

### Notification to Partner
```
🎉 Thank You — An Investment Was Made for You!

Great news! UGX 500,000 has been invested from your wallet by our operations team to help tenants access housing.

💰 You'll earn 15% (UGX 75,000) monthly on the 27th of every month for 12 months, starting 2026-04-26.

Thank you for being part of the Welile family! 🙏

Ref: WCI2603271234
```

---

## 6. Creating a Manual Portfolio

### Purpose
Create a portfolio record for a partner WITHOUT deducting from their wallet. Used for historical data entry, imported records, or special arrangements.

### Flow
1. Open partner detail → click "Add New Portfolio" button at bottom
2. Fill form:
   - **Amount** (min 50K, quick buttons: 500K–10M)
   - **ROI %** (default 20)
   - **Duration** (default 12 months)
   - **ROI Mode** (Monthly Payout or Compounding)
   - **Payout Day** (default 15, range 1–28)
   - **Contribution Date** (optional, for backdating)
3. Preview shows: Amount, Monthly ROI calculation, Maturity period
4. Submit creates:
   - `investor_portfolios` record (`investor_id = agent_id = partnerId`)
   - `general_ledger` entry (category `coo_manual_portfolio`)
   - `audit_logs` entry (action `create_manual_portfolio`)

### Example
```
Partner: Esther Namukisha
Amount: 1,000,000 UGX
ROI: 20%
Duration: 12 months
Mode: Monthly Compounding
Payout Day: 15
Date: 2025-11-20 (backdated)

→ Portfolio code: WIP2511204567
→ Monthly ROI: UGX 200,000
→ Maturity: 2026-11-20
→ Next ROI: 2025-12-15
```

---

## 7. Editing a Portfolio

### Flow
1. Open partner detail → click "Edit" on portfolio card
2. Full edit dialog opens with current values pre-filled
3. Editable fields:
   - Investment Amount (min 50K)
   - ROI % (1–100)
   - ROI Mode (Payout / Compounding)
   - Duration (1–120 months)
   - Status (active / pending / pending_approval / matured / cancelled)
   - Invested-On Date (optional override)
4. Preview shows calculated monthly ROI
5. On save:
   - Full before/after diff logged to `audit_logs`
   - Portfolio record updated
   - Local state updated optimistically

### Example
```
Before: { amount: 500,000, roi: 15%, mode: payout }
After:  { amount: 1,000,000, roi: 20%, mode: compounding }

Audit metadata.changes:
{
  "investment_amount": { "from": 500000, "to": 1000000 },
  "roi_percentage": { "from": 15, "to": 20 },
  "roi_mode": { "from": "monthly_payout", "to": "monthly_compounding" }
}
```

---

## 8. Deleting a Portfolio

### Flow
1. Click "Delete" on portfolio card
2. Confirmation dialog appears with portfolio details (code, amount, status)
3. Enter reason (minimum 10 characters, maximum 500)
4. On confirm:
   - Audit log captures full portfolio snapshot + reason
   - Portfolio record is permanently deleted
   - Local state updated
   - Parent table refreshed

### Example
```
Portfolio: WCI2603271234 — UGX 500,000 — Active
Reason: "Duplicate portfolio created during import. Original is WCI2603201111."

→ audit_logs: {
    action_type: "delete_investment_portfolio",
    metadata: {
      portfolio_code: "WCI2603271234",
      investment_amount: 500000,
      reason: "Duplicate portfolio...",
      partner_name: "Benjamin Kato"
    }
  }
→ Portfolio deleted from investor_portfolios
→ Toast: "Portfolio WCI2603271234 deleted — Action logged for audit."
```

---

## 9. Approving Portfolios

### Single Approval
1. In partner detail, portfolio with status `pending_approval` shows "Approve" button
2. Click → updates status to `active`
3. Also approves linked `pending_wallet_operations`
4. Audit-logged

### Bulk Activation
1. Filter bar shows "Activate All (N)" button when pending portfolios exist
2. Click → confirmation dialog
3. Confirm → batch update ALL `pending_approval` → `active`
4. Toast shows count

### Example
```
5 portfolios with status "pending_approval"
→ "Activate All (5)" button visible
→ Click → "This will activate 5 pending portfolios. Continue?"
→ Confirm → UPDATE investor_portfolios SET status = 'active' WHERE status = 'pending_approval'
→ Toast: "5 portfolios activated successfully"
→ Button disappears
```

---

## 10. Wallet → Portfolio Transfer Flow

### Purpose
Move funds from a partner's **existing wallet balance** into an **existing active portfolio**, increasing its capital.

### Flow
1. In partner detail, click "Wallet → Portfolio" on an active portfolio (only visible if wallet balance > 0)
2. Dialog shows:
   - Portfolio name/code and current capital
   - Current wallet balance
   - Amount input (min 1,000, max = wallet balance, quick buttons + Max)
   - Reason input (min 10 chars)
   - Preview: transfer amount, remaining wallet
3. Submit calls edge function
4. Wallet deducted, portfolio capital increased at maturity

### Example
```
Partner: Benjamin Kato
Wallet: 1,500,000 UGX
Portfolio: "Kato's Rent Account" — Capital: 2,000,000 UGX

Transfer: 500,000 UGX
Reason: "Partner requested wallet-to-portfolio transfer"

→ Wallet: 1,500,000 → 1,000,000
→ Portfolio pending top-up: +500,000
→ Toast: "Transfer complete"
```

---

## 11. External Top-Up (Fund Portfolio)

### Purpose
Add external funds (from outside the platform) into a portfolio. Uses `FundInvestmentAccountDialog`.

### Flow
1. Click "Top Up" on active portfolio card
2. Dialog from `FundInvestmentAccountDialog` opens
3. Enter amount and source details
4. Creates `pending_wallet_operation` with type `portfolio_topup`
5. Awaits approval before applying

---

## 12. Applying Pending Top-Ups

### Flow
1. Portfolio card shows "Apply N Pending" button when pending operations exist
2. Click calls `apply-pending-topups` edge function with `portfolio_id`
3. Edge function processes all pending deposits for that portfolio
4. Returns: count of applied deposits, total amount, new investment total
5. Partner detail refreshes

### Example
```
Portfolio WCI2603271234 has 2 pending top-ups: 200K + 300K

→ POST apply-pending-topups { portfolio_id: "..." }
→ Response: { count: 2, total_applied: 500000, new_investment_total: 1000000 }
→ Toast: "2 pending deposit(s) applied — UGX 500,000 added. New capital: UGX 1,000,000"
```

---

## 13. Renewing a Portfolio

### Flow
1. Click "Renew" on portfolio card → `RenewPortfolioDialog` opens
2. Renewal extends the portfolio by 12 months
3. Resets `total_roi_earned` counter
4. Updates `maturity_date`
5. Tracks renewal count in `portfolio_renewals` table
6. Badge shows "×1", "×2" on subsequent renewals

---

## 14. Editing a Partner Profile

### Flow (from COOPartnersPage)
1. Click three-dot menu → "Edit Partner"
2. Dialog opens with: Name, Phone, ROI %, ROI Mode
3. On save:
   - Updates `profiles` (name, phone)
   - Updates ALL active/pending `investor_portfolios` for this partner (both `investor_id` and `agent_id`)
   - If no portfolios exist: triggers **orphan repair** (see Section 23)

### Flow (from ActivePartnersDetail)
1. Same dialog but also includes Payout Day field
2. Additional logic for orphan portfolio creation

---

## 15. Suspending & Reactivating a Partner

### Suspend
1. Click three-dot menu → "Suspend"
2. Confirmation dialog (no reason required in COOPartnersPage; required in ActivePartnersDetail)
3. Sets `profiles.frozen_at = NOW()` and `profiles.frozen_reason = "Suspended by COO"`
4. Partner row appears dimmed (opacity-60)
5. Status shows red "SUSPENDED" badge

### Reactivate
1. Click three-dot menu → "Reactivate" (only on suspended partners)
2. Clears `profiles.frozen_at` and `profiles.frozen_reason`
3. Partner returns to normal appearance

### ActivePartnersDetail Variant
- Uses `user_roles.enabled = false` instead of profile freezing
- Requires 10+ character reason
- Audit-logged with reason

---

## 16. Deleting a Partner

### Flow
1. Click three-dot menu → "Delete Partner"
2. Confirmation dialog with reason input (min 10 chars)
3. On confirm:
   - Deletes `supporter` role from `user_roles`
   - Freezes profile with reason: `"Deleted by COO: {reason}"`
   - Audit-logged (action `partner_deleted`)
4. Partner disappears from directory on refresh

### What's Preserved
- Wallet balance (frozen, not deleted)
- Ledger entries (immutable audit trail)
- Portfolio records (for financial reconciliation)
- Profile record (marked as frozen)

---

## 17. Bulk Import Partners from Excel

### Full Flow

**Step 1: Upload**
1. User clicks "Import" button in filter bar
2. Drag-and-drop or file picker for `.xlsx` files
3. Max 500 rows per file

**Step 2: Parse & Validate**
1. XLSX is parsed using `xlsx` library
2. Headers are normalized using alias mapping (e.g., "SUPPORTER NAME" → "Partner Name")
3. Each row is validated:
   - Name required
   - Phone normalized (strips +256 prefix)
   - Amount ≥ 50,000
   - ROI between 1–30%
   - Duration 1–36 months
   - ROI mode must be `monthly_payout` or `monthly_compounding`
   - Contribution date parsed (ISO, US, EU, Excel serial)
4. Rows grouped by phone → email → individual
5. Existing phones checked against `profiles` table

**Step 3: Preview**
Shows 4 stat cards:
- New Partners (valid groups without existing phone)
- Portfolios (total across all groups)
- Existing (phone matches in DB — will add portfolios to existing account)
- Errors (invalid rows)

Each group shows:
- Partner name + phone + email
- Portfolio count and total amount
- Validation errors (if any)
- "Existing" badge (if phone match found)

**Step 4: Confirm**
Final summary:
- Partners to create
- Portfolios to create
- Total investment amount
- Existing accounts getting new portfolios

**Step 5: Processing**
Payload sent to `import-partners` edge function:
```json
{
  "partners": [
    {
      "partner_name": "Ssenkaali Pius",
      "phone": "0700123456",
      "email": "pius@example.com",
      "portfolios": [
        { "amount": 500000, "roiPercentage": 15, "durationMonths": 12, "roiMode": "monthly_compounding", "contributionDate": "2025-03-09" },
        { "amount": 300000, "roiPercentage": 15, "durationMonths": 12, "roiMode": "monthly_payout", "contributionDate": "2025-01-15" }
      ]
    }
  ]
}
```

**Step 6: Results**
Shows: partners created, portfolios created, skipped duplicates, errors (with partner name and error message).

### Example Template Row
```
| Partner Name    | Phone      | Email            | Investment Amount | Contribution Date | ROI % | Duration (Months) | ROI Mode            |
|-----------------|------------|------------------|-------------------|-------------------|-------|-------------------|---------------------|
| Ssenkaali Pius  | 0700123456 | pius@example.com | 500000            | 2025-03-09        | 15    | 12                | monthly_compounding |
```

---

## 18. Bulk Activate Pending Portfolios

### Flow
1. System checks `investor_portfolios` count where `status = 'pending_approval'`
2. If count > 0, green "Activate All (N)" button appears in filter bar
3. Click → confirmation dialog
4. Confirm → `UPDATE investor_portfolios SET status = 'active' WHERE status = 'pending_approval'`
5. Toast with count
6. Table refreshes

---

## 19. Exporting Partner Data

### Flow
1. Click "Export CSV" button in filter bar
2. Generates CSV with columns: Name, Phone, Status, Wallet, Total Funded, Deals, Avg Deal, ROI %, Payout Day, ROI Mode, Joined
3. Downloads as `partners-export.csv`
4. Exports current **filtered** view (respects search, status, ROI mode filters)

---

## 20. Portfolio PDF & WhatsApp Sharing

### PDF Download
1. Click "PDF" button on portfolio card
2. Calls `downloadPortfolioPdf()` with portfolio data
3. Generates and downloads PDF with: code, name, amount, ROI %, mode, status, dates, owner

### WhatsApp Share
1. Click "WhatsApp" button on portfolio card
2. Calls `sharePortfolioViaWhatsApp()` with same data
3. Opens WhatsApp with pre-formatted message

---

## 21. Editing Portfolio Payout Day (Inline)

### Flow
1. In partner detail, each portfolio shows payout day with pencil icon
2. Click pencil → input field appears (number, 1–28)
3. Enter new day → click save (checkmark)
4. Updates `investor_portfolios.payout_day`
5. Local state updated optimistically
6. Click X to cancel

---

## 22. Editing Portfolio Account Name (Inline)

### Flow
1. In partner detail, portfolio code shows pencil icon
2. Click → text input appears with current name (or empty)
3. Enter new name → save
4. Updates `investor_portfolios.account_name`
5. Audit-logged (action `edit_portfolio_name`)
6. Empty input clears the name

---

## 23. Orphan Portfolio Repair

### When It Triggers
When editing a partner's ROI but NO active/pending portfolios exist for them.

### Flow
1. Edit partner → set ROI to 20%
2. System updates `investor_portfolios` → 0 rows affected
3. System queries `general_ledger` for latest `cash_out` entry with `supporter_rent_fund` category
4. If found:
   - Parses payout day from description (`Payout day: 15`)
   - Parses portfolio code from description (or generates `WPF-{id-prefix}`)
   - Creates portfolio from ledger data with the new ROI
   - Sets duration to 12 months
   - Toast: "Updated Esther — created missing portfolio with 20% ROI"
5. If no ledger entry found:
   - Toast warning: "Profile updated but no investment records found"

---

## 24. Error Handling & Rollback Patterns

### Wallet Deduction Failure (Optimistic Lock)
```
Scenario: Two COOs invest for the same partner simultaneously

COO-A: balance=1M, invest 500K → UPDATE wallets SET balance=500K WHERE balance=1M ✅
COO-B: balance=1M, invest 300K → UPDATE wallets SET balance=700K WHERE balance=1M ❌ (0 rows, balance already 500K)
COO-B gets: "Insufficient balance or concurrent update, please retry"
```

### Ledger Insert Failure
```
Scenario: Database error during ledger insert after wallet deduction

1. Wallet deducted: 1M → 500K
2. Ledger insert fails (e.g., constraint violation)
3. ROLLBACK: UPDATE wallets SET balance=1M WHERE user_id=partner_id
4. Return: "Failed to record transaction, wallet restored. Please retry."
```

### Portfolio Creation Failure
```
Scenario: Portfolio insert fails after successful wallet + ledger operations

1. Wallet deducted ✅
2. Ledger entries created ✅
3. Portfolio insert fails ❌
4. NOT rolled back (ledger is source of truth)
5. Logged: "[coo-invest-for-partner] Portfolio creation failed: {error}"
6. Ops can manually fix via partner detail → "Add New Portfolio"
```

### Edge Function Error Extraction
```typescript
const { data: result, error } = await supabase.functions.invoke('coo-invest-for-partner', { body });
if (error) {
  const { extractFromErrorObject } = await import('@/lib/extractEdgeFunctionError');
  const errMsg = await extractFromErrorObject(error, 'Investment failed');
  throw new Error(errMsg);
}
if (result?.error) throw new Error(result.error);
```

---

## 25. Security & Access Control

### Role Requirements

| Action | Required Role | Enforcement |
|---|---|---|
| View partners | `manager` | Client-side route guard + data query |
| Invest for partner | `manager` | Edge function checks `user_roles` |
| Import partners | `manager` | Edge function checks `user_roles` |
| Edit partner/portfolio | `manager` | Client-side (RLS on tables) |
| Delete partner | `manager` | Client-side + audit log |
| Bulk activate | `manager` | Client-side (RLS) |
| Wallet → Portfolio | `manager`, `super_admin`, `coo` | Edge function checks |

### Data Isolation
- Partners see ONLY their own portfolios (RLS: `investor_id = auth.uid() OR agent_id = auth.uid()`)
- COO/Manager sees ALL supporter data via batched queries
- Edge functions use `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS)

### Input Validation
- UUID format: `^[0-9a-f]{8}-[0-9a-f]{4}-...$/i`
- Amount: `≥ 50,000` (investment), `≥ 1,000` (transfer)
- Payout day: `1–28`
- ROI: `1–100%` (UI), `1–30%` (import)
- Reason fields: `≥ 10 characters`
- Phone: normalized, 10+ digits

### Audit Trail
Every mutation creates an immutable `audit_logs` entry with:
- `user_id`: Who performed the action
- `action_type`: What was done
- `table_name`: Which table was affected
- `record_id`: Which record was affected
- `metadata`: Full context (before/after values, reasons, names)

---

## Appendix: Ledger Categories

| Category | Direction | Used By |
|---|---|---|
| `coo_proxy_investment` | `cash_out` | Proxy investment (partner side) |
| `pool_capital_received` | `cash_in` | Proxy investment (pool side) |
| `coo_manual_portfolio` | `cash_out` | Manual portfolio creation |
| `supporter_rent_fund` | `cash_out` | Self-service investment |
| `supporter_facilitation_capital` | `cash_out` | Facilitated capital |

---

## Appendix: Portfolio Status Values

| Status | Meaning | Transition From |
|---|---|---|
| `pending` | Awaiting initial activation | Import, manual create |
| `pending_approval` | Import created, needs COO approval | Import |
| `active` | Live, earning ROI | pending, pending_approval |
| `matured` | Duration completed | active |
| `cancelled` | Manually terminated | any |

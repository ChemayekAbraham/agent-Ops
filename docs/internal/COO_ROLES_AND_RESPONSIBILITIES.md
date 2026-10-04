# COO (Chief Operating Officer) — Roles & Responsibilities

> **Platform:** Welile Rent Management System  
> **Last Updated:** March 2026

---

## 🎯 Role Overview

The COO oversees **all financial operations** across the Welile platform. They are the final authority on fund movements, withdrawal approvals, partner governance, and operational risk management. The COO dashboard is accessed via a dedicated isolated route (`/coo/dashboard`) with a sidebar-driven multi-tab layout.

---

## 📊 Dashboard Modules

### 1. Financial Operations Overview
- **Financial Metrics Cards** — Real-time KPIs: total collections, active wallets, transaction volume, and float utilisation.
- **Payment Mode Analytics** — Breakdown of collections by payment method (cash, mobile money, bank transfer).
- **Agent Collections Overview** — Aggregated view of all agent collection activity, including visit counts and amounts collected.
- **Wallet Monitoring Panel** — Platform-wide wallet health: balances, low-balance alerts, and wallet activity trends.

### 2. Transaction Monitoring
- **Financial Transactions Table** (`FinancialTransactionsTable`) — Full general ledger view with filtering, search, and export. Displays amount, direction, category, source table, linked party, and timestamps from the `general_ledger` table.

### 3. Agent Collections
- **Agent Collections Overview** (`AgentCollectionsOverview`) — Detailed agent-level collection performance: amounts, payment methods, float before/after, mobile money details, and visit correlation.

### 4. Wallet Monitoring
- **Wallet Monitoring Panel** (`WalletMonitoringPanel`) — Tracks all user wallets across roles. Surfaces wallets with anomalous activity or critically low balances.

### 5. Payment Analytics
- **Payment Mode Analytics** (`PaymentModeAnalytics`) — Charts and breakdowns of payment channels, provider distribution, and collection trends over time.

### 6. Financial Reports
- **Financial Reports Panel** (`FinancialReportsPanel`) — Exportable financial reports including daily summaries, monthly reconciliations, and custom date-range queries.

### 7. Risk & Alerts
- **Financial Alerts Panel** (`FinancialAlertsPanel`) — Automated risk alerts: suspicious transactions, float limit breaches, failed collections, and anomaly detection across the ledger.

---

## 🔐 Governance Responsibilities

### 8. Withdrawal Approvals (Final Authority)
- **COO Withdrawal Approvals** (`COOWithdrawalApprovals`) — The COO is the **final approver** for all withdrawal requests. After manager-level review, withdrawals require explicit COO sign-off.
  - Sets `coo_approved_at` and `coo_approved_by` on the `withdrawal_requests` table.
  - Can reject withdrawals with a reason.
  - Pending approvals are highlighted with an animated badge.

### 9. Partner Management
- **COO Partners Page** (`COOPartnersPage`) — Full partner (supporter/funder) governance:
  - View all partners with financial summaries (total invested, ROI earned, ledger activity).
  - **Import partners** via CSV/Excel using the `PartnerImportDialog`.
  - **Create investment portfolios** for partners directly (`coo_manual_portfolio` ledger category).
  - **Invest on behalf of partners** via the `coo-invest-for-partner` edge function.
  - **Freeze/unfreeze partner accounts** — Sets `frozen_at` and `frozen_reason` on profiles.
  - **COO Confirmation Required** — All critical partner actions require explicit COO confirmation dialogs.

### 10. Staff Performance
- **Staff Performance Panel** (`StaffPerformancePanel`) — Cross-role staff performance metrics, accessible from the COO governance section.

---

## 🧩 UI & Navigation

| Sidebar Section       | Tab ID             | Component                    |
|-----------------------|--------------------|------------------------------|
| Financial Operations  | `overview`         | FinancialMetricsCards + PaymentModeAnalytics + FinancialAlertsPanel + AgentCollectionsOverview + WalletMonitoringPanel |
| Financial Operations  | `transactions`     | FinancialTransactionsTable   |
| Financial Operations  | `collections`      | AgentCollectionsOverview     |
| Financial Operations  | `wallets`          | WalletMonitoringPanel        |
| Financial Operations  | `analytics`        | PaymentModeAnalytics         |
| Governance            | `reports`          | FinancialReportsPanel        |
| Governance            | `alerts`           | FinancialAlertsPanel         |
| Governance            | `withdrawals`      | COOWithdrawalApprovals       |
| Governance            | `partners`         | COOPartnersPage              |
| Governance            | `staff-performance` | StaffPerformancePanel       |

---

## 🔑 Key Permissions

- ✅ Final approval/rejection of all withdrawal requests
- ✅ Create and manage investment portfolios for partners
- ✅ Invest on behalf of partners (proxy investments)
- ✅ Freeze/unfreeze user accounts
- ✅ Import partners in bulk (CSV/Excel)
- ✅ Access full general ledger and financial reports
- ✅ Monitor all agent collections and wallet activity
- ✅ View staff performance metrics
- ✅ Access risk alerts and anomaly detection

---

## 🛡️ Security Notes

- The COO role is an **isolated role** — users with this role are redirected away from the general `/dashboard` to `/coo/dashboard`.
- All critical actions (withdrawals, freezes, investments) are logged in the `audit_logs` and `general_ledger` tables.
- Partner proxy investments use a dedicated edge function (`coo-invest-for-partner`) with server-side validation.
- COO confirmation dialogs are enforced on all destructive or high-value operations.

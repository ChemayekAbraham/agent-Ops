# Welile Technologies Limited — System Architecture & Structure

> **Last Updated:** March 11, 2026  
> **Platform:** Rent-guarantee and rent-facilitation fintech  
> **Stack:** React + Vite + Tailwind CSS + TypeScript | Lovable Cloud (Supabase)  
> **Target Scale:** 40M+ users across Africa and globally

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Core Architecture](#2-core-architecture)
3. [Role Definitions & Access](#3-role-definitions--access)
4. [Dashboard Breakdown by Role](#4-dashboard-breakdown-by-role)
5. [Edge Functions (Backend)](#5-edge-functions-backend)
6. [Financial Engine](#6-financial-engine)
7. [Database Schema Highlights](#7-database-schema-highlights)
8. [Security Architecture](#8-security-architecture)
9. [Approval & Governance Flows](#9-approval--governance-flows)

---

## 1. System Overview

Welile connects **tenants**, **landlords**, **agents**, and **supporters (funders/investors)** to facilitate rent payments across Africa. The platform acts as the **system operator and guarantor** — it facilitates rent, manages risk, and earns fees for infrastructure and guarantees. It does **not** sell loans.

### Core Business Flow

```
Supporter → Contributes Capital → Rent Management Pool
                                        ↓
Manager → Approves Rent Request → Deploys Funds → Landlord Wallet
                                        ↓
Tenant → Receives Rent Facilitation → Repays via Installments
                                        ↓
Agent → Collects Repayments (field) → Platform → Supporter ROI
```

---

## 2. Core Architecture

### 2.1 Frontend Architecture

| Layer | Technology |
|-------|-----------|
| Framework | React 18 + TypeScript |
| Build | Vite |
| Styling | Tailwind CSS + shadcn/ui |
| State | TanStack React Query |
| Routing | React Router v6 |
| Animations | Framer Motion |
| PWA | vite-plugin-pwa |
| Maps | Leaflet + React Leaflet |
| Charts | Recharts |
| PDF | jsPDF |
| QR | html5-qrcode + qrcode.react |

### 2.2 Backend Architecture

| Layer | Technology |
|-------|-----------|
| Database | PostgreSQL (via Lovable Cloud) |
| Auth | Supabase Auth (email + password, OTP) |
| API | Supabase Client SDK (auto-generated types) |
| Edge Functions | Deno (41 functions) |
| Storage | Supabase Storage |
| Realtime | Supabase Realtime (postgres_changes) |
| Cron | pg_cron (auto-charge wallets daily at 06:00 UTC) |

### 2.3 Financial Architecture

- **Double-Entry Ledger**: Append-only `general_ledger` table with debit/credit entries
- **Wallet Sync Trigger**: `sync_wallet_from_ledger` fires on ledger inserts with `transaction_group_id`
- **No Direct Wallet Edits**: RLS policies deny client-side writes to wallets/ledger
- **Approval Gates**: External transactions routed through `pending_wallet_operations`

### 2.4 Role-Based Dashboard Isolation

- **Isolated Roles** (dedicated environments): CEO, CTO, CFO, COO, CMO, CRM, Operations
- **Sidebar Roles** (original dashboard): Manager, Super Admin
- **Standard Roles** (main dashboard): Tenant, Agent, Landlord, Supporter
- Access enforced via `RoleGuard` component + role-prefixed routes

---

## 3. Role Definitions & Access

| # | Role | Route | Description |
|---|------|-------|-------------|
| 1 | `tenant` | `/dashboard` | End-user renting housing |
| 2 | `agent` | `/dashboard` | Field operator: registrations, collections, facilitation |
| 3 | `landlord` | `/dashboard` | Property owner receiving rent |
| 4 | `supporter` | `/dashboard` | Investor/funder contributing capital to rent pool |
| 5 | `manager` | `/dashboard` | Platform administrator: approvals, user management |
| 6 | `super_admin` | `/admin/dashboard` | System-wide admin with full control |
| 7 | `ceo` | `/ceo/dashboard` | Executive oversight: revenue, growth, health |
| 8 | `coo` | `/coo/dashboard` | Financial operations: transactions, collections, wallets |
| 9 | `cfo` | `/cfo/dashboard` | Financial governance: statements, solvency, reconciliation |
| 10 | `cto` | `/cto/dashboard` | Engineering: infrastructure, API, security, dev tools |
| 11 | `cmo` | `/cmo/dashboard` | Marketing: growth metrics, signups, campaigns |
| 12 | `crm` | `/crm/dashboard` | Customer relations: profiles, tickets, disputes |
| 13 | `employee` | `/dashboard` | General staff |
| 14 | `operations` | `/operations` | Operational workflows |

---

## 4. Dashboard Breakdown by Role

---

### 4.1 🏠 Tenant Dashboard

**Route:** `/dashboard` (role: tenant)

**Components:**
| Feature | Component | Description |
|---------|-----------|-------------|
| Rent Request | `RentRequestButton` + `RentRequestForm` | Submit rent facilitation requests with landlord details, location, utility meters |
| Repayment Schedule | `RepaymentScheduleView` | View installment plan and upcoming charges |
| Repayment History | `RepaymentHistoryDrawer` | Full history of rent repayments |
| Repayment Section | `RepaymentSection` | Active obligations and amounts due |
| Credit Access | `RentAccessLimitCard` + `CreditAccessCard` | View credit limit (base + bonuses from receipts, ratings, rent history) |
| Rent Calculator | `RentCalculator` + `WeeklyMonthlyCalculator` | Calculate weekly/monthly affordability |
| Subscription Status | `SubscriptionStatusCard` | Auto-charge subscription status |
| Rent Discount | `RentDiscountWidget` + `RentDiscountToggle` | Apply rent discounts |
| My Landlords | `MyLandlordsSection` | View registered landlords |
| Register Landlord | `RegisterLandlordDialog` | Add a new landlord |
| Payment Streak | `PaymentStreakCalendar` | Gamified on-time payment tracking |
| Achievement Badges | `AchievementBadges` + `ShareableAchievementCard` | Earn and share milestones |
| Invite Friends | `InviteFriendsCard` | Referral program |
| Quick Contribute | `QuickContributeDialog` | Quick payment actions |
| Welile Homes | `WelileHomesButton` | Access Welile Homes savings program |
| Menu | `TenantMenuDrawer` | Sliding navigation drawer |

**Key Pages:**
- `/my-loans` — Loan management
- `/my-receipts` — Receipt history
- `/payment-schedule` — Payment schedule view
- `/rent-discount-history` — Discount history
- `/welile-homes` — Savings program

---

### 4.2 🤝 Agent Dashboard

**Route:** `/dashboard` (role: agent)

**Components:**
| Feature | Component | Description |
|---------|-----------|-------------|
| Registration Hub | `UnifiedRegistrationDialog` | Register tenants, landlords, supporters in one flow |
| Register Tenant | `RegisterTenantDialog` | Full tenant registration with location |
| Register Landlord | `RegisterLandlordDialog` | Landlord onboarding with property details |
| Register Sub-Agent | `RegisterSubAgentDialog` | Recruit sub-agents |
| Rent Requests | `AgentRentRequestDialog` + `AgentMyRentRequestsSheet` | Submit and track rent facilitation requests |
| Rent Request Manager | `AgentRentRequestsManager` | Manage all submitted requests |
| Invest for Partner | `AgentInvestForPartnerDialog` | Proxy investment on behalf of supporters (approval-gated) |
| Proxy Investment History | `ProxyInvestmentHistorySheet` | Track all proxy investments |
| Deposit Cash | `AgentDepositCashDialog` + `AgentDepositDialog` | Process cash deposits |
| Withdrawal | `AgentWithdrawalDialog` | Request fund withdrawals |
| Record Collection | `RecordAgentCollectionDialog` | Log field rent collections with GPS, MoMo details |
| Record Payment | `RecordTenantPaymentDialog` | Log tenant payments |
| Visit & Payment Wizard | `AgentVisitDialog` + `AgentVisitPaymentWizard` | GPS check-in + payment collection flow |
| Generate Payment Token | `GeneratePaymentTokenDialog` | Create payment tokens for tenants |
| Tenants Sheet | `AgentTenantsSheet` | View assigned tenants |
| Managed Properties | `AgentManagedPropertiesSheet` + `AgentManagedPropertyDialog` | View/manage properties |
| Landlord Map | `AgentLandlordMapSheet` | Map view of registered landlords |
| Landlord Payout | `AgentLandlordPayoutDialog` | Initiate landlord payments |
| Top Up Tenant | `AgentTopUpTenantDialog` | Add funds to tenant wallet |
| Daily Ops | `AgentDailyOpsCard` | Daily operational summary |
| Goal Tracking | `AgentGoalCard` + `AgentGoalProgress` | Monthly registration/activation targets |
| Team Goals | `TeamGoalProgress` + `SetTeamGoalDialog` | Sub-agent team targets |
| Earnings Rank | `EarningsRankSystemSheet` | Commission ranking system |
| Leaderboard | `AgentLeaderboard` | Performance leaderboard |
| Commission Payouts | `MyCommissionPayouts` + `RequestCommissionPayoutDialog` | View/request commission cashouts |
| Pending Deposits | `PendingDepositsSection` | Track deposit approvals |
| Invites | `AgentInvitesList` + `CreateUserInviteDialog` | Manage user invitations |
| Sub-Agents | `SubAgentsList` + `SubAgentInvitesList` | Manage recruited sub-agents |
| Link Signups | `LinkSignupsList` + `CollapsibleLinkSignups` | Track referral link signups |
| Share Referral | `ShareReferralLink` + `ShareSubAgentLink` | Share referral/recruit links |
| Shareable Cards | `ShareablePerformanceCard` + `ShareableMilestoneCard` | Social media performance cards |
| MoMo Settings | `MobileMoneySettings` | Configure mobile money details |
| Credit Verification | `CreditVerificationButton` | Verify credit requests |
| Verification Opportunities | `VerificationOpportunitiesButton` | Find earning opportunities |
| Rental Finder | `RentalFinderSheet` | Find available rentals |
| Loan Management | `LoanManagement` + `LoanPaymentCalculator` | Agent loan tools |
| Rent Payment Guide | `AgentRentPaymentGuide` | Step-by-step payment guide |
| Registration Analytics | `AgentRegistrationAnalytics` | Registration performance stats |
| Menu | `AgentMenuDrawer` | Sliding navigation drawer |

**Key Pages:**
- `/agent-registrations` — Registration history
- `/agent-analytics` — Performance analytics
- `/agent-earnings` — Earnings breakdown
- `/sub-agent-analytics` — Sub-agent performance
- `/agent-advances` — Capital advance management

---

### 4.3 🏘️ Landlord Dashboard

**Route:** `/dashboard` (role: landlord)

**Components:**
| Feature | Component | Description |
|---------|-----------|-------------|
| My Tenants | `MyTenantsSection` | View all registered tenants |
| Add Tenant | `LandlordAddTenantDialog` | Register a new tenant |
| My Properties | `MyPropertiesSheet` | View/manage properties |
| Register Property | `RegisterPropertyDialog` | Add a new property |
| Tenant Rating | `TenantRating` | Rate tenant payment behavior |
| Encouragement Message | `EncouragementMessageDialog` | Send motivational messages to tenants |
| Welile Homes | `LandlordWelileHomesSection` | Welile Homes savings enrollment |
| Enroll Tenant | `EnrollTenantWelileHomesDialog` | Enroll tenants in savings program |
| Manage Subscription | `ManageTenantSubscriptionDialog` | Manage tenant auto-charge subscriptions |
| Welile Homes Badge | `WelileHomesLandlordBadge` | Achievement badge |
| Leaderboard | `WelileHomesLandlordLeaderboard` | Landlord performance ranking |
| Menu | `LandlordMenuDrawer` | Sliding navigation drawer |

---

### 4.4 💰 Supporter (Funder/Investor) Dashboard

**Route:** `/dashboard` (role: supporter)

**UI Isolation:** Supporters **NEVER** see tenants, landlords, agents, user lists, names, phone numbers, or IDs. They ONLY see Virtual Houses, rent amounts, payment health, and portfolio performance.

**Components:**
| Feature | Component | Description |
|---------|-----------|-------------|
| Hero Balance | `HeroBalanceCard` | Wallet balance with fund/withdraw actions |
| Portfolio Summary | `PortfolioSummaryCards` | Total invested, ROI earned, active portfolios |
| Quick Stats | `QuickStatsRow` | Key metrics at a glance |
| Quick Actions | `ModernQuickActions` + `ModernQuickLinks` | Fund account, invest, view history |
| Investment Breakdown | `InvestmentBreakdownSheet` | Per-portfolio details with 30-day cycle / calendar-day payout logic |
| Investment Calculator | `InvestmentCalculator` | ROI projection tool |
| Investment Card | `SimpleInvestmentCard` | Summary investment card |
| Investment Goals | `InvestmentGoals` + `SetGoalDialog` | Set and track investment targets |
| Investment Packages | `InvestmentPackageSheet` | Available investment tiers |
| Fund Account | `FundAccountDialog` | Deposit funds into wallet |
| Fund Rent | `FundRentDialog` | Direct rent pool contribution |
| Funding Pool | `FundingPoolCard` | Pool balance and health |
| Withdrawal | `InvestmentWithdrawButton` + `WithdrawAccountDialog` | Request withdrawals (90-day notice) |
| Account Details | `AccountDetailsDialog` | Banking/MoMo details for payouts |
| Create Account | `CreateAccountDialog` | Set up payout account |
| Virtual Houses | `VirtualHousesFeed` + `VirtualHouseCard` + `VirtualHouseDetailsSheet` | Anonymized view of funded houses |
| House Opportunities | `HouseOpportunities` | Available funding opportunities |
| Opportunity Summary | `OpportunitySummaryCard` + `OpportunityHeroButton` | Investment opportunity overview |
| Opportunity Tabs | `ModernOpportunityTabs` | Browse by category |
| Rent Categories | `RentCategoryFeed` | Rent requests by tier |
| Credit Requests Feed | `CreditRequestsFeed` | Incoming credit requests |
| Tenant Details | `TenantRequestDetailsDialog` | Anonymized tenant request details |
| Tenants Needing Rent | `TenantsNeedingRent` + `SimpleTenantsList` | Anonymized tenants requiring support |
| ROI Earnings | `ROIEarningsCard` | Monthly ROI earned |
| Interest History | `InterestPaymentHistory` | Payout history |
| Funded History | `FundedHistory` | Past funding records |
| Funding Milestones | `FundingMilestones` | Achievement milestones |
| My Investment Requests | `MyInvestmentRequests` | Track investment request status |
| Request Manager Invest | `RequestManagerInvestDialog` | Request manager to invest on your behalf |
| Pay Landlord | `PayLandlordDialog` | Direct landlord payment |
| Merchant Codes | `MerchantCodePills` | Quick payment merchant codes |
| Leaderboard | `SupporterLeaderboard` + `SupporterROILeaderboard` | Funding and ROI rankings |
| Referral Stats | `SupporterReferralStats` | Referral performance |
| Notifications | `NotificationBell` + `NotificationsModal` + `SupporterNotificationsFeed` | In-app notification system |
| Share Links | `ShareSupporterLink` + `ShareCalculatorLink` | Social sharing |
| Invite Card | `ModernInviteCard` | Invite new supporters |
| Calculator Share | `CalculatorShareCard` | Share calculator results |
| User Profile | `UserProfileDialog` | View profile |
| Floating Portfolio | `FloatingPortfolioButton` | Quick portfolio access FAB |
| Menu | `SupporterMenuDrawer` | Sliding navigation drawer |

**Key Pages:**
- `/opportunities` — Full opportunity browser
- `/supporter-earnings` — Detailed earnings view
- `/investment-portfolio` — Full portfolio view
- `/calculator` — Public investment calculator

---

### 4.5 🛡️ Manager Dashboard

**Route:** `/dashboard` (role: manager)  
**Layout:** Original sidebar-based dashboard

**Sidebar Sections:**
| Section | Item | ID |
|---------|------|----|
| Administration | Dashboard Access | `access-panel` |
| Administration | User Management | `users` |
| Administration | Deposits | `deposits` |
| Administration | Audit Log | `audit` |

**Components:**
| Feature | Component | Description |
|---------|-----------|-------------|
| **User Management** | | |
| User Profiles Table | `UserProfilesTable` | Searchable, filterable user list |
| User Details | `UserDetailsDialog` | Full user profile with ledger, wallet, roles |
| User Count Summary | `UserCountsSummary` + `CompactUserStats` | Role-based user statistics |
| Quick Role Editor | `QuickRoleEditor` + `MobileRoleEditor` + `InlineRoleToggle` | Rapid role assignment |
| Bulk Role Assign | `BulkAssignRoleDialog` + `BulkRemoveRoleDialog` | Mass role operations |
| Bulk WhatsApp | `BulkWhatsAppDialog` | Mass communication |
| Inactive User Outreach | `InactiveUsersReachOutDialog` | Re-engagement |
| Duplicate Phone Detection | `DuplicatePhoneUsersSheet` | Fraud detection |
| Role History | `RoleHistoryViewer` | Audit trail of role changes |
| Simple User Card | `SimpleUserCard` | Compact user summary |
| Password Reset | `PasswordResetGuide` | Guide for resetting user passwords |
| **Financial Operations** | | |
| KPI Strip | `ManagerKPIStrip` + `ManagerKPIDetailDrawer` | Key financial metrics |
| Financial Overview | `FinancialOverview` + `FinancialCharts` + `FinancialAlerts` | Platform financial health |
| Ledger Summary | `ManagerLedgerSummary` | Aggregate ledger view |
| General Ledger | `GeneralLedger` + `DayGroupedLedger` | Full ledger browser |
| Banking Ledger | `ManagerBankingLedger` | Banking operations |
| Financial Statements | `FinancialStatementsPanel` | Income, cash flow, balance sheet |
| Fund Flow Tracker | `FundFlowTracker` | Capital movement visualization |
| Period Comparison | `PeriodComparison` | Period-over-period analysis |
| **Approval Workflows** | | |
| Pending Rent Requests | `PendingRentRequestsWidget` | Approve/reject rent facilitations |
| Approved Requests Funding | `ApprovedRequestsFundingWidget` | Deploy pool funds to approved requests |
| Rent Request Manager | `RentRequestsManager` | Full rent request lifecycle |
| Deposit Requests | `ManagerDepositsWidget` + `DepositRequestsManager` | Approve deposits |
| Deposit Analytics | `DepositAnalytics` | Deposit trends |
| Deposit/Rent Audit | `DepositRentAuditWidget` | Cross-reference deposits vs rent |
| Pending Wallet Operations | `PendingWalletOperationsWidget` | Approve proxy investments, commissions |
| Pending Investment Requests | `PendingInvestmentRequestsWidget` | Approve supporter investment requests |
| Pending Invites | `PendingInvitesWidget` | Manage activation invites |
| Loan Applications | `LoanApplicationsManager` | Approve/reject loans |
| Withdrawal Requests | `WithdrawalRequestsManager` | Process withdrawal requests |
| Commission Payouts | `AgentCommissionPayoutsManager` | Process agent commission cashouts |
| Payment Confirmations | `PaymentConfirmationsManager` | Verify payments |
| Payment Proofs | `PaymentProofsManager` | Review payment evidence |
| **Agent Oversight** | | |
| Agent Float Manager | `AgentFloatManager` | Manage agent capital limits |
| Agent Earnings Overview | `AgentEarningsOverview` | System-wide agent earnings |
| Agent Details | `AgentDetailsDialog` | Deep-dive into agent performance |
| Agent Collections | `AgentCollectionsWidget` | Monitor field collections |
| Issue Advance | `IssueAdvanceSheet` | Issue capital advances to agents |
| Paid Agents History | `PaidAgentsHistory` | Commission payout history |
| **Supporter Management** | | |
| Supporter Pool Balance | `SupporterPoolBalanceCard` | Pool health: balance, deployed, reserve, deployable |
| Create Supporter | `CreateSupporterDialog` + `CreateSupporterWithAccountDialog` | Onboard new supporters |
| Supporter Invites | `SupporterInvitesList` | Track supporter invitations |
| Supporter ROI Trigger | `SupporterROITrigger` | Manually trigger ROI processing |
| Monthly Rewards Trigger | `MonthlyRewardsTrigger` | Manually trigger reward payouts |
| Investment Accounts | `InvestmentAccountsManager` | Manage investment accounts |
| Create/Edit/Fund Investment | `CreateInvestmentAccountDialog` + `EditInvestmentAccountDialog` + `FundInvestmentAccountDialog` | Investment account CRUD |
| Investment Edit History | `InvestmentEditHistoryDialog` | Audit trail of investment changes |
| Investment Requests | `ManagerInvestmentRequestsSection` | Manager-side investment requests |
| Opportunity Summary | `OpportunitySummaryForm` | Create/edit opportunity summaries |
| Reserve Allocation | `ReserveAllocationPanel` | Configure reserve percentages |
| Buffer Account | `BufferAccountPanel` + `BufferTrendChart` | Monitor solvency buffers |
| **Platform Tools** | | |
| Hub Cards | `ManagerHubCards` | Quick navigation cards |
| Quick Actions | `MobileQuickActions` + `QuickActionsDropdown` + `QuickUserActions` | Rapid action buttons |
| Floating Actions | `FloatingUserActions` + `FloatingDepositsWidget` | Floating action buttons |
| Activity Manager | `ActivityManager` | Platform activity feed |
| Active Users | `ActiveUsersCard` | Online user tracking |
| Receipt Management | `ReceiptManagement` | Receipt verification |
| Printable Receipt | `PrintableReceiptSheet` | Generate printable receipts |
| Orders | `OrdersManager` | Marketplace order management |
| Vendor Analytics | `VendorAnalytics` | Marketplace vendor stats |
| User Locations | `UserLocationsManager` | Geographic user distribution |
| Welile Homes Subscriptions | `WelileHomesSubscriptionsManager` | Savings program management |
| Welile Homes Withdrawals | `WelileHomesWithdrawalsManager` | Savings withdrawal processing |
| Subscription Monitor | `SubscriptionMonitorWidget` | Auto-charge subscription status |
| Record Merchant Payment | `RecordMerchantPayment` | Log merchant transactions |
| AI Brain | `AIBrainDashboard` | AI-powered platform insights |
| AI Recommendations | `AIRecommendationCard` | AI-suggested actions |
| AI Session History | `AISessionHistory` | AI interaction logs |
| AI User Report | `AIUserExperienceReport` | AI-generated user experience analysis |
| Force Refresh | `ForceRefreshManager` | Clear caches/force data refresh |
| Chromecast | `ChromecastButton` | Cast dashboard to TV |
| Daily Report | `DailyReportMetrics` | End-of-day summary |
| Tips | `ManagerTip` | Contextual management tips |
| Audit Log | `AuditLogViewer` | Full audit trail |

**Key Pages:**
- `/user-management` — Full user management
- `/deposits-management` — Deposit approval with pagination
- `/financial-statement` — Financial statements
- `/audit-log` — Audit trail
- `/transaction-history` — Transaction browser

---

### 4.6 👑 Super Admin Dashboard

**Route:** `/admin/dashboard`

**Sidebar Sections:**
| Section | Item | ID |
|---------|------|----|
| Administration | Dashboard Access | `access-panel` |
| Administration | User Management | `users` |
| Administration | Audit Log | `audit` |
| Administration | System Config | `config` |

**Capabilities:** Full access to all Manager features + system configuration + role assignment with authorization codes.

---

### 4.7 📊 CEO Dashboard

**Route:** `/ceo/dashboard`  
**Layout:** `ExecutiveDashboardLayout`

**Sidebar Sections:**
| Section | Item | ID |
|---------|------|----|
| Executive | Platform Overview | `overview` |
| Executive | Revenue & Growth | `revenue` |
| Executive | Users & Coverage | `users` |
| Executive | Financial Health | `financial` |

**Components:**
| Feature | Component | Description |
|---------|-----------|-------------|
| CEO Dashboard | `CEODashboard` | North star metrics: Rent Secured, Active Houses, Coverage |
| Tenant Ops | `TenantOpsDashboard` | Tenant funnel and health |
| Agent Ops | `AgentOpsDashboard` | Agent performance and coverage |
| Landlord Ops | `LandlordOpsDashboard` | Landlord engagement |
| Partners Ops | `PartnersOpsDashboard` | Supporter capital and ROI |
| KPI Cards | `KPICard` | Standardized metric display |
| Data Table | `ExecutiveDataTable` | Sortable, searchable executive data |

**COO Drilldown Pages:**
- `/coo/active-users` — Active user details
- `/coo/active-partners` — Active partner details
- `/coo/active-landlords` — Active landlord details
- `/coo/earning-agents` — Top earning agents
- `/coo/new-partner-requests` — New partner requests
- `/coo/new-rent-requests` — New rent requests
- `/coo/pipeline-landlords` — Pipeline landlords
- `/coo/rent-coverage` — Rent coverage analysis
- `/coo/tenant-balances` — Tenant balance details

---

### 4.8 ⚙️ COO Dashboard

**Route:** `/coo/dashboard`  
**Layout:** `ExecutiveDashboardLayout`

**Sidebar Sections:**
| Section | Item | ID |
|---------|------|----|
| Financial Operations | Overview | `overview` |
| Financial Operations | Transactions | `transactions` |
| Financial Operations | Agent Collections | `collections` |
| Financial Operations | Wallets | `wallets` |
| Financial Operations | Payment Analytics | `analytics` |
| Governance | Reports | `reports` |
| Governance | Alerts | `alerts` |
| Governance | Withdrawal Approvals | `withdrawals` |
| Governance | Partners | `partners` |

**Components:**
| Feature | Component | Description |
|---------|-----------|-------------|
| Financial Metrics | `FinancialMetricsCards` | Rent collected, payments today/month, wallet balances, pending approvals |
| Transactions Table | `FinancialTransactionsTable` | Searchable ledger with CSV export, multi-criteria filters |
| Agent Collections | `AgentCollectionsOverview` | Field activity: tracking IDs, GPS locations, MoMo verification, KPIs |
| Wallet Monitoring | `WalletMonitoringPanel` | Master wallet, agent wallets, settlements |
| Payment Analytics | `PaymentModeAnalytics` | MTN/Airtel/Cash/Wallet distribution charts |
| Reports | `FinancialReportsPanel` | Downloadable revenue summaries |
| Alerts | `FinancialAlertsPanel` | Anomaly detection (payments > 2M UGX) |
| Withdrawal Approvals | `COOWithdrawalApprovals` | Multi-stage withdrawal processing |
| Partners Management | `COOPartnersPage` | Full partner oversight with search, filters, CSV export |
| Detail Layout | `COODetailLayout` | Consistent detail page layout |
| Data Table | `COODataTable` | Reusable sortable/filterable table |

**Key Features:**
- Transaction authorization (separate approval from disbursement)
- Manual ROI and referral payout triggers (after liquidity verification)
- Solvency governance (Coverage Ratio > 1.2x)
- Identity & compliance verification
- Invest for Partner (via `coo-invest-for-partner` edge function)
- Payout day override for individual portfolios (1-28)
- Account suspension via `frozen_at` field

---

### 4.9 💼 CFO Dashboard

**Route:** `/cfo/dashboard`  
**Layout:** `ExecutiveDashboardLayout`

**Sidebar Sections:**
| Section | Item | ID |
|---------|------|----|
| Finance | Overview | `overview` |
| Finance | Financial Statements | `statements` |
| Finance | Solvency & Buffer | `solvency` |
| Finance | Reconciliation | `reconciliation` |
| Finance | General Ledger | `ledger` |
| Finance | Commission Payouts | `commissions` |
| Finance | Withdrawals | `withdrawals` |

**Components:**
| Feature | Component | Description |
|---------|-----------|-------------|
| Reconciliation Panel | `CFOReconciliationPanel` | Compare wallets vs ledger totals, detect gaps, batch-fetch profiles |
| Withdrawal Approvals | `CFOWithdrawalApprovals` | CFO-stage withdrawal authorization |

**Key Features:**
- Income Statement, Balance Sheet, Cash Flow views
- Compact currency display (3.5M, 120K) with tooltips
- CSV export for offline auditing
- Mandatory CFO sign-off for: ROI payouts, commissions, withdrawal requests
- Buffer/escrow monitoring
- Coverage ratio and liquidity indicators

---

### 4.10 🔧 CTO Dashboard

**Route:** `/cto/dashboard`  
**Layout:** `ExecutiveDashboardLayout`

**Sidebar Sections:**
| Section | Item | ID |
|---------|------|----|
| Engineering | Overview | `overview` |
| Engineering | System Infrastructure | `infrastructure` |
| Engineering | API Management | `api` |
| Engineering | Security Logs | `security` |
| Engineering | Developer Tools | `tools` |

**Component:** `CTODashboard`

---

### 4.11 📢 CMO Dashboard

**Route:** `/cmo/dashboard`  
**Layout:** `ExecutiveDashboardLayout`

**Sidebar Sections:**
| Section | Item | ID |
|---------|------|----|
| Marketing | Overview | `overview` |
| Marketing | Growth Metrics | `growth` |
| Marketing | Signup Trends | `signups` |
| Marketing | Referral Performance | `referrals` |
| Marketing | Campaign Analytics | `campaigns` |

**Component:** `CMODashboard`

---

### 4.12 🎧 CRM Dashboard

**Route:** `/crm/dashboard`  
**Layout:** `ExecutiveDashboardLayout`

**Sidebar Sections:**
| Section | Item | ID |
|---------|------|----|
| Customer Relations | Overview | `overview` |
| Customer Relations | Customer Profiles | `profiles` |
| Customer Relations | Support Tickets | `tickets` |
| Customer Relations | Disputes | `disputes` |
| Customer Relations | Communications | `communications` |

**Component:** `CRMDashboard`

---

## 5. Edge Functions (Backend)

### 5.1 Authentication & Onboarding
| Function | Description |
|----------|-------------|
| `activate-supporter` | Activate invited supporter/agent/landlord accounts with rate limiting |
| `create-supporter-invite` | Generate invite links with temp passwords |
| `register-tenant` | Register new tenants |
| `admin-reset-password` | Administrative password reset |
| `password-reset-sms` | SMS-based password reset |
| `sms-otp` | OTP verification |
| `vendor-login` | Vendor portal authentication |

### 5.2 Financial Operations
| Function | Description |
|----------|-------------|
| `agent-deposit` | Process agent cash deposits |
| `agent-withdrawal` | Process agent withdrawal requests |
| `approve-deposit` | Manager/COO deposit approval |
| `wallet-transfer` | Wallet-to-wallet transfer (currently suspended for security) |
| `fund-rent-pool` | Supporter → rent management pool transfer (instant) |
| `fund-tenant-from-pool` | Deploy pool funds to approved rent requests |
| `fund-tenants` | Bulk tenant funding |
| `auto-charge-wallets` | Daily pg_cron auto-charge for subscriptions |
| `manual-collect-rent` | Manual rent collection recording |
| `seed-test-funds` | Test environment fund seeding |

### 5.3 Investment & Portfolio
| Function | Description |
|----------|-------------|
| `agent-invest-for-partner` | Agent proxy investment (approval-gated, portfolio created as `pending_approval`) |
| `coo-invest-for-partner` | COO proxy investment with neutral branding |
| `create-investor-portfolio` | Direct portfolio creation |
| `approve-wallet-operation` | Manager approval of pending credits (activates portfolios on approval, refunds agent on rejection) |
| `process-investment-interest` | Process investment interest accrual |
| `process-supporter-roi` | Process supporter ROI payouts |
| `process-monthly-rewards` | Process monthly reward distributions |

### 5.4 Rent Facilitation
| Function | Description |
|----------|-------------|
| `approve-rent-request` | Multi-stage rent request approval |
| `approve-loan-application` | Loan application approval |
| `delete-rent-request` | Manager rent request deletion |
| `check-repayment-status` | Check tenant repayment obligations |

### 5.5 Agent Operations
| Function | Description |
|----------|-------------|
| `process-agent-advance-deductions` | Daily advance interest/deductions |
| `send-collection-sms` | SMS notifications for collections |

### 5.6 Notifications & Reminders
| Function | Description |
|----------|-------------|
| `send-push-notification` | Push notification delivery |
| `notify-watchers` | Notify opportunity watchers |
| `payment-reminder` | Payment due reminders |
| `rent-reminders` | Rent due reminders |

### 5.7 Marketplace & Receipts
| Function | Description |
|----------|-------------|
| `product-purchase` | Process marketplace purchases |
| `vendor-mark-receipt` | Vendor receipt confirmation |
| `scan-receipt` | AI receipt scanning |

### 5.8 AI & Analytics
| Function | Description |
|----------|-------------|
| `welile-ai-chat` | AI chatbot for user support |
| `user-snapshot` | Generate user data snapshots |
| `validate-payload` | Server-side payload validation |

### 5.9 User Management
| Function | Description |
|----------|-------------|
| `delete-user` | Account deletion |

---

## 6. Financial Engine

### 6.1 Revenue Categories
| Category | Description |
|----------|-------------|
| `tenant_access_fee` | One-time tenant access fee |
| `tenant_request_fee` | Per-request facilitation fee |
| `platform_service_income` | General service income |

### 6.2 Expense Categories
| Category | Description |
|----------|-------------|
| `supporter_platform_rewards` | Monthly ROI payouts to supporters |
| `agent_commission_payout` | Agent commission payments |
| `rent_facilitation_payout` | Rent deployment to landlords |
| `transaction_platform_expenses` | Transaction processing costs |
| `operational_expenses` | General operating costs |

### 6.3 Capital Movement Categories
| Category | Description |
|----------|-------------|
| `supporter_facilitation_capital` | Supporter investment capital (approval-gated) |
| `supporter_rent_fund` | Direct pool contributions (instant) |
| `coo_proxy_investment` | COO proxy investments |
| `agent_remittance` | Agent field remittances |
| `rent_repayment` | Tenant rent repayments |
| `pool_rent_deployment` | Pool → landlord deployments |
| `proxy_investment_commission` | Agent 2% proxy commission |

### 6.4 Approval Hierarchy

```
┌──────────────────────────────────────────────────────┐
│                    APPROVAL GATES                     │
├───────────────────┬──────────────────────────────────┤
│ Instant           │ Internal wallet → pool transfers │
│                   │ Agent wallet deductions          │
├───────────────────┼──────────────────────────────────┤
│ Manager Approval  │ Proxy investment credits         │
│                   │ Agent commissions                │
│                   │ Deposit requests                 │
├───────────────────┼──────────────────────────────────┤
│ Financial Ops     │ External withdrawals             │
│ Single-Step       │   (TID/Receipt/Bank Ref required)│
│                   │                                  │
└───────────────────┴──────────────────────────────────┘
```

### 6.5 Investment Flow (Agent → Partner)

```
1. Agent submits proxy investment (min UGX 50,000)
2. Agent wallet: DEBITED immediately (optimistic lock)
3. Portfolio created: status = 'pending_approval'
4. Pending operation created: partner credit queued
5. Agent commission (2%): queued separately
   ─── WAITING FOR APPROVAL ───
6. COO/Manager approves pending operation
7. General ledger entry created (with transaction_group_id)
8. sync_wallet_from_ledger trigger fires → partner wallet CREDITED
9. Portfolio status updated to 'active'
10. Partner can now invest, fund tenants
   ─── OR IF REJECTED ───
6b. Portfolio status → 'cancelled'
7b. Agent wallet: RESTORED (refund)
8b. Agent notified with rejection reason
```

---

## 7. Database Schema Highlights

### 7.1 Core Tables
| Table | Purpose |
|-------|---------|
| `profiles` | User profiles (name, phone, avatar) |
| `user_roles` | Role assignments (separate from profiles for security) |
| `wallets` | User wallet balances (read-only, updated by triggers) |
| `general_ledger` | Immutable financial transaction log |
| `pending_wallet_operations` | Approval queue for external transactions |
| `notifications` | In-app notification delivery |
| `audit_logs` | Administrative action audit trail |

### 7.2 Rent Facilitation Tables
| Table | Purpose |
|-------|---------|
| `landlords` | Landlord registration with property details, GPS, utility meters |
| `credit_request_details` | Full rent facilitation request details |
| `credit_access_limits` | Tenant credit limits with bonus components |

### 7.3 Investment Tables
| Table | Purpose |
|-------|---------|
| `investor_portfolios` | Portfolio records (amount, ROI%, status, payout schedule) |
| `supporter_invites` | Invitation management with activation tokens |
| `investment_withdrawal_requests` | Withdrawal requests with 90-day notice |

### 7.4 Agent Operations Tables
| Table | Purpose |
|-------|---------|
| `agent_collections` | Field collection records with GPS, MoMo, payment method |
| `agent_visits` | GPS check-in records |
| `agent_earnings` | Commission and bonus tracking |
| `agent_float_limits` | Float limits and daily transaction caps |
| `agent_advances` | Capital advances with interest |
| `agent_advance_ledger` | Daily advance deduction records |
| `agent_subagents` | Sub-agent hierarchy |
| `agent_goals` | Monthly performance targets |

### 7.5 Accounting Tables
| Table | Purpose |
|-------|---------|
| `ledger_accounts` | Chart of accounts |
| `ledger_account_groups` | Account groupings |
| `deposit_requests` | Deposit approval queue |
| `earning_baselines` | Performance baseline calculations |
| `earning_predictions` | AI earning predictions |

### 7.6 Communication Tables
| Table | Purpose |
|-------|---------|
| `conversations` | Chat conversations |
| `conversation_participants` | Chat participants |
| `ai_chat_messages` | AI chatbot history |

### 7.7 Marketplace Tables
| Table | Purpose |
|-------|---------|
| `products` | Marketplace product listings |
| `cart_items` | Shopping cart |

---

## 8. Security Architecture

### 8.1 RLS (Row-Level Security)
- System-only tables (ledger, earnings, repayments) deny direct client-side writes
- Operations restricted to service-role Edge Functions or managers
- OTP verifications have explicit deny-all for authenticated users
- Materialized views have SELECT revoked from public/anon

### 8.2 Authentication
- Email + password with email verification (no auto-confirm by default)
- SMS OTP for mobile users
- Rate limiting on activation (5 attempts, 1-hour lockout)
- Wallet-to-wallet transfers suspended for security review

### 8.3 Authorization
| Action | Allowed Roles |
|--------|--------------|
| Role assignment | `super_admin`, `manager`, `cto` |
| Account freeze/delete | `super_admin`, `manager`, `cto`, `coo` |
| Deposit approval | `manager`, `coo` |
| Withdrawal approval | Financial Ops single-step (TID/receipt/bank ref required) |
| Proxy investment | `agent`, `coo` |

### 8.4 Financial Safety
- Optimistic locking on wallet updates
- 60-second cooldown on rapid-fire investments
- Cascading rollback on partial failures
- Pre-payout liquidity gate (15% reserve)
- Negative balance prevention

---

## 9. Approval & Governance Flows

### 9.1 Rent Facilitation
```
Tenant/Agent submits request
  → Agent verification (location, utility meters)
  → Manager verification (approve/reject/edit)
  → Landlord verification
  → Manager deploys pool funds → Landlord wallet credited
  → Tenant obligation created → Auto-charge subscription starts
```

### 9.2 Supporter Onboarding
```
Agent creates invite (temp password + activation token)
  → Partner receives link
  → Partner activates account (email, name, password)
  → Portfolios linked (if pre-invested by agent)
  → Pending wallet operations linked to new user_id
  → Awaits manager/COO approval before wallet credit
```

### 9.3 Withdrawal Processing
```
User requests withdrawal
  → Stage 1: Requested
  → Stage 2: Manager review
  → Stage 3: CFO sign-off
  → Stage 4: COO final approval
  → Funds disbursed
```

### 9.4 Monthly ROI Payout
```
COO verifies pool liquidity (Coverage Ratio > 1.2x)
  → Triggers process-supporter-roi
  → Each active portfolio with due next_roi_date processed
  → 30-day cycle or calendar-day payout (based on payout_day)
  → Ledger entries created → Wallet sync trigger fires
  → Supporter notified
```

---

> **Governing Principles:**
> - Dignity before growth
> - Systems over heroics
> - Calm over urgency
> - Trust over shortcuts
> - Outcomes over optics
> - Auditability over convenience
>
> **North Star Metric:** Rent Secured (UGX / month)

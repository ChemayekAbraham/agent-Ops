# Welile Technologies — Complete Platform Workflow & Feature Reference

> **Last Updated:** April 2, 2026  
> **Platform:** Welile Technologies Limited — Rent-guarantee and rent-facilitation fintech  
> **Stack:** React 18 + Vite 5 + Tailwind CSS + TypeScript | Lovable Cloud (Supabase)  
> **Target Scale:** 40M+ users across Africa and globally

---

## Table of Contents

1. [Platform Overview](#1-platform-overview)
2. [Core Architecture](#2-core-architecture)
3. [Role Definitions & Access (14 Roles)](#3-role-definitions--access)
4. [Tenant Dashboard](#4-tenant-dashboard)
5. [Agent Dashboard](#5-agent-dashboard)
6. [Landlord Dashboard](#6-landlord-dashboard)
7. [Supporter (Funder) Dashboard](#7-supporter-funder-dashboard)
8. [Manager Dashboard](#8-manager-dashboard)
9. [Super Admin Dashboard](#9-super-admin-dashboard)
10. [CEO Dashboard](#10-ceo-dashboard)
11. [COO Dashboard](#11-coo-dashboard)
12. [CFO Dashboard](#12-cfo-dashboard)
13. [CTO Dashboard](#13-cto-dashboard)
14. [CMO Dashboard](#14-cmo-dashboard)
15. [CRM Dashboard](#15-crm-dashboard)
16. [Executive Hub](#16-executive-hub)
17. [Wallet System](#17-wallet-system)
18. [Deposit Flow](#18-deposit-flow)
19. [Withdrawal Flow](#19-withdrawal-flow)
20. [Rent Facilitation Flow](#20-rent-facilitation-flow)
21. [Access Fee & Compounding Logic](#21-access-fee--compounding-logic)
22. [Repayment & Auto-Charge System](#22-repayment--auto-charge-system)
23. [Agent Earnings & Commission Structure](#23-agent-earnings--commission-structure)
24. [Agent Advance (Credit) System](#24-agent-advance-credit-system)
25. [Supporter Investment Model](#25-supporter-investment-model)
26. [Rent Management Pool](#26-rent-management-pool)
27. [Proxy Investment Flow](#27-proxy-investment-flow)
28. [Credit Access System](#28-credit-access-system)
29. [Welile Homes Savings Program](#29-welile-homes-savings-program)
30. [Landlord Guaranteed Rent Program](#30-landlord-guaranteed-rent-program)
31. [Double-Entry Ledger System](#31-double-entry-ledger-system)
32. [Edge Functions (80+ Backend Functions)](#32-edge-functions)
33. [Event-Based Architecture](#33-event-based-architecture)
34. [Cost Optimization & Performance](#34-cost-optimization--performance)
35. [Security Architecture](#35-security-architecture)
36. [Approval & Governance Flows](#36-approval--governance-flows)
37. [SMS & Notification System](#37-sms--notification-system)
38. [AI Features](#38-ai-features)
39. [PWA & Offline Support](#39-pwa--offline-support)
40. [Marketplace](#40-marketplace)
41. [Referral & Ambassador System](#41-referral--ambassador-system)
42. [Revenue Recognition Model](#42-revenue-recognition-model)
43. [Risk, Buffer & Solvency Rules](#43-risk-buffer--solvency-rules)
44. [Key Platform KPIs](#44-key-platform-kpis)
45. [Cash Flow Summary by Role](#45-cash-flow-summary-by-role)
46. [Database Schema Overview](#46-database-schema-overview)
47. [Utility Libraries](#47-utility-libraries)
48. [Governing Principles](#48-governing-principles)

---

## 1. Platform Overview

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

### 2.1 Frontend Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 18 + TypeScript |
| Build | Vite 5 |
| Styling | Tailwind CSS v3 + shadcn/ui |
| State | TanStack React Query v5 |
| Routing | React Router v6 |
| Animations | Framer Motion |
| PWA | vite-plugin-pwa |
| Maps | Leaflet + React Leaflet |
| Charts | Recharts |
| PDF | jsPDF |
| QR | html5-qrcode + qrcode.react |
| Spreadsheet | xlsx |

### 2.2 Backend Stack

| Layer | Technology |
|-------|-----------|
| Database | PostgreSQL (via Lovable Cloud) |
| Auth | Supabase Auth (email + password, OTP, SMS) |
| API | Supabase Client SDK (auto-generated types) |
| Edge Functions | Deno (80+ functions) |
| Storage | Supabase Storage |
| Realtime | Supabase Realtime (postgres_changes) |
| Cron | pg_cron (auto-charge, daily stats, advance deductions) |

### 2.3 Financial Architecture

- **Double-Entry Ledger**: Append-only `general_ledger` table with debit/credit entries
- **Wallet Sync Trigger**: `sync_wallet_from_ledger` fires on ledger inserts with `transaction_group_id`
- **No Direct Wallet Edits**: RLS policies deny client-side writes to wallets/ledger
- **Approval Gates**: External transactions routed through `pending_wallet_operations`
- **Event-Based Audit**: `system_events` table with 39+ event types tracking all financial state transitions

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

### Role Switching & Auto-Routing

- Users with **≥ UGX 100,000** deployed capital are auto-routed to the Supporter dashboard
- Users below the threshold can switch to any public role (`tenant`, `agent`, `landlord`, `supporter`) seamlessly with auto-provisioning
- High-capital investors require **manager-approved "Role Access Request"** to switch to other roles
- Default Dashboard preference in Settings overrides auto-routing when set

### Account Frozen State

Users flagged with `is_frozen = true` are **completely blocked** from all dashboards. Shows full-screen destructive overlay with WhatsApp support contact. Only action: Sign Out.

---

## 4. Tenant Dashboard

**Route:** `/dashboard` (role: tenant)

### Components

| Feature | Component | Description |
|---------|-----------|-------------|
| Rent Request | `RentRequestButton` + `RentRequestForm` | Submit rent facilitation with landlord details, location, utility meters |
| Repayment Schedule | `RepaymentScheduleView` | Installment plan and upcoming charges |
| Repayment History | `RepaymentHistoryDrawer` | Full repayment log |
| Repayment Section | `RepaymentSection` | Active obligations and amounts due |
| Credit Access | `RentAccessLimitCard` + `CreditAccessCard` | Dynamic credit limit (base + bonuses) |
| Rent Calculator | `RentCalculator` + `WeeklyMonthlyCalculator` | Weekly/monthly affordability calculator |
| Subscription Status | `SubscriptionStatusCard` | Auto-charge subscription state |
| Rent Discount | `RentDiscountWidget` + `RentDiscountToggle` | Apply rent discounts |
| My Landlords | `MyLandlordsSection` | View registered landlords |
| Register Landlord | `RegisterLandlordDialog` | Add a new landlord |
| Payment Streak | `PaymentStreakCalendar` | Gamified on-time payment tracking |
| Achievement Badges | `AchievementBadges` + `ShareableAchievementCard` | Earn and share milestones |
| Invite Friends | `InviteFriendsCard` | Referral program |
| Quick Contribute | `QuickContributeDialog` | Quick payment actions |
| Welile Homes | `WelileHomesButton` | Savings program access |
| Loan Progress | `LoanProgressWidget` | Loan tracking |
| Income Type | `IncomeTypeSelector` | Income classification |
| Find a House | `FindAHouseCTA` + `AvailableHousesSheet` + `NearbyHousesPreview` + `SuggestedHousesCard` | Browse available properties |
| Share House | `ShareHouseButton` | Share property listings |
| WhatsApp Agent | `WhatsAppAgentButton` | Direct agent contact |
| Menu | `TenantMenuDrawer` | Sliding navigation drawer |
| Agreement | `agreement/` | Tenant participation agreement system |

### Key Pages

- `/my-loans` — Loan management
- `/my-receipts` — Receipt history
- `/payment-schedule` — Payment schedule
- `/rent-discount-history` — Discount history
- `/welile-homes` — Savings program
- `/find-a-house` — Property browser
- `/calculator` — Public rent calculator

---

## 5. Agent Dashboard

**Route:** `/dashboard` (role: agent)  
**Design:** Mobile-first with pull-to-refresh, haptic feedback, skeleton loading, and offline caching.

### Components

| Feature | Component | Description |
|---------|-----------|-------------|
| **Registration** | | |
| Unified Registration | `UnifiedRegistrationDialog` | Register tenants, landlords, supporters in one flow |
| Register Tenant | `RegisterTenantDialog` | Full tenant registration with location |
| Register Landlord | `RegisterLandlordDialog` | Landlord onboarding with property details |
| Register Sub-Agent | `RegisterSubAgentDialog` | Recruit sub-agents |
| **Rent Operations** | | |
| Rent Requests | `AgentRentRequestDialog` + `AgentMyRentRequestsSheet` | Submit and track rent requests |
| Rent Request Manager | `AgentRentRequestsManager` | Manage all submitted requests |
| Tenant Rent Requests | `AgentTenantRentRequestsList` | Per-tenant request list |
| Rent Payment Guide | `AgentRentPaymentGuide` | Step-by-step payment guide |
| **Investment** | | |
| Invest for Partner | `AgentInvestForPartnerDialog` | Proxy investment (approval-gated) |
| Partner Dashboard | `AgentPartnerDashboardSheet` | Partner overview |
| Proxy History | `ProxyInvestmentHistorySheet` | Track proxy investments |
| Funder Management | `FunderManagementSheet` | Manage funder relationships |
| Funder Portfolio | `FunderPortfolioCard` | Portfolio display |
| **Financial** | | |
| Deposit Cash | `AgentDepositCashDialog` + `AgentDepositDialog` | Process cash deposits |
| Withdrawal | `AgentWithdrawalDialog` | Request withdrawals |
| Top Up Tenant | `AgentTopUpTenantDialog` | Add funds to tenant wallet |
| Receipt Dialog | `AgentReceiptDialog` | Generate receipts |
| Float Payout | `AgentFloatPayoutWizard` + `FloatPayoutStatusTracker` | Float payout management |
| Landlord Float | `AgentLandlordFloatCard` | Landlord float balance |
| Landlord Payout | `AgentLandlordPayoutDialog` + `AgentLandlordPayoutFlow` | Initiate landlord payments |
| Landlord Recovery | `LandlordRecoveryLedger` | Recovery tracking |
| Float History | `FloatTransactionHistory` | Float movement log |
| Ops Float Review | `AgentOpsFloatPayoutReview` | Operations review |
| **Field Operations** | | |
| Visit & Payment | `AgentVisitDialog` + `AgentVisitPaymentWizard` | GPS check-in + payment collection |
| Record Collection | `RecordAgentCollectionDialog` | Log field collections with GPS, MoMo |
| Record Payment | `RecordTenantPaymentDialog` | Log tenant payments |
| Payment Token | `GeneratePaymentTokenDialog` | Create payment tokens |
| Delivery Confirm | `AgentDeliveryConfirmation` | Confirm rent delivery |
| **Daily Ops** | | |
| Daily Ops Card | `AgentDailyOpsCard` | Daily operational summary |
| Today Collections | `TodayCollectionsCard` | Today's collection count/amount |
| Daily Rent Expected | `DailyRentExpectedCard` | Expected daily collections |
| Priority Queue | `PriorityCollectionQueue` | Priority collection list |
| No-Smartphone Manager | `NoSmartphoneScheduleManager` | Manage offline tenants |
| Action Insights | `AgentActionInsights` | AI action suggestions |
| **Performance** | | |
| Goal Tracking | `AgentGoalCard` + `AgentGoalProgress` | Monthly targets |
| Team Goals | `TeamGoalProgress` + `SetTeamGoalDialog` | Sub-agent team targets |
| Earnings Rank | `EarningsRankSystemSheet` | Commission ranking |
| Leaderboard | `AgentLeaderboard` | Performance leaderboard |
| Earnings Forecast | `EarningsForecastCard` | Predicted earnings |
| Collection Streak | `CollectionStreakCard` | Gamified streak tracking |
| Registration Analytics | `AgentRegistrationAnalytics` | Registration stats |
| Commission Payouts | `MyCommissionPayouts` + `RequestCommissionPayoutDialog` | View/request cashouts |
| Cash Payouts | `AgentCashPayoutsTab` | Cash payout tracking |
| **Team Management** | | |
| Tenants Sheet | `AgentTenantsSheet` | View assigned tenants |
| Nearby Tenants | `NearbyTenantsSheet` | GPS-based nearby tenants |
| Sub-Agents | `SubAgentsList` + `SubAgentInvitesList` + `MySubAgentsSheet` | Manage sub-agents |
| Invites | `AgentInvitesList` + `CreateUserInviteDialog` | User invitations |
| Link Signups | `LinkSignupsList` + `CollapsibleLinkSignups` | Referral link signups |
| **Property** | | |
| Managed Properties | `AgentManagedPropertiesSheet` + `AgentManagedPropertyDialog` | View/manage properties |
| Landlord Map | `AgentLandlordMapSheet` | Map view of landlords |
| Listings | `AgentListingsSheet` + `ListEmptyHouseDialog` + `HouseImageUploader` | House listings |
| Rental Finder | `RentalFinderSheet` | Find available rentals |
| Verification | `CreditVerificationButton` + `VerificationOpportunitiesButton` + `AgentVerificationOpportunitiesCard` | Verify credit/find opportunities |
| **Sharing** | | |
| Share Referral | `ShareReferralLink` + `ShareSubAgentLink` + `QuickShareSubAgentSheet` | Share referral links |
| Shareable Cards | `ShareablePerformanceCard` + `ShareableMilestoneCard` | Social media cards |
| Recruit CTA | `RecruitSubAgentCTA` + `RecruitTenantWelileHomes` | Recruitment prompts |
| **Finance** | | |
| Loan Management | `LoanManagement` + `LoanPaymentCalculator` | Agent loan tools |
| MoMo Settings | `MobileMoneySettings` | Mobile money config |
| Pending Deposits | `PendingDepositsSection` | Deposit approval tracking |
| Menu | `AgentMenuDrawer` | Navigation drawer |
| Agreement | `agreement/` | Agent participation agreement |

### Key Pages

- `/agent-registrations` — Registration history
- `/agent-analytics` — Performance analytics
- `/agent-earnings` — Earnings breakdown
- `/sub-agent-analytics` — Sub-agent performance
- `/agent-advances` — Capital advance management
- `/pay-landlord` — Landlord payment flow

---

## 6. Landlord Dashboard

**Route:** `/dashboard` (role: landlord)

### Components

| Feature | Component | Description |
|---------|-----------|-------------|
| My Tenants | `MyTenantsSection` | View all registered tenants |
| Add Tenant | `LandlordAddTenantDialog` | Register a new tenant |
| My Properties | `MyPropertiesSheet` | View/manage properties |
| Register Property | `RegisterPropertyDialog` | Add a new property |
| Tenant Rating | `TenantRating` | Rate tenant payment behavior |
| Encouragement Message | `EncouragementMessageDialog` | Send motivational messages |
| Payment History | `LandlordPaymentHistory` | Rent payment records |
| Welile Homes | `LandlordWelileHomesSection` | Savings enrollment |
| Enroll Tenant | `EnrollTenantWelileHomesDialog` | Enroll tenants in savings |
| Manage Subscription | `ManageTenantSubscriptionDialog` | Auto-charge subscriptions |
| Welile Homes Badge | `WelileHomesLandlordBadge` | Achievement badge |
| Leaderboard | `WelileHomesLandlordLeaderboard` | Performance ranking |
| Menu | `LandlordMenuDrawer` | Navigation drawer |
| Agreement | `agreement/` | Landlord participation agreement |

### Key Pages

- `/landlord-welile-homes` — Welile Homes landlord view

---

## 7. Supporter (Funder) Dashboard

**Route:** `/dashboard` (role: supporter)  
**UI Isolation:** Supporters **NEVER** see tenants, landlords, agents, names, phone numbers, or IDs. Only Virtual Houses, rent amounts, payment health, and portfolio performance.

### Components

| Feature | Component | Description |
|---------|-----------|-------------|
| **Portfolio** | | |
| Hero Balance | `HeroBalanceCard` | Mesh gradient hero with ROI indicators, glassmorphism |
| Portfolio Summary | `PortfolioSummaryCards` | Tappable cards: total invested, ROI, active portfolios |
| Quick Stats | `QuickStatsRow` | At-a-glance metrics |
| Quick Actions | `ModernQuickActions` + `ModernQuickLinks` | Fund, invest, view history |
| Investment Breakdown | `InvestmentBreakdownSheet` | Per-portfolio details with payout logic |
| Investment Calculator | `InvestmentCalculator` | Regulatory-compliant ROI projection tool |
| Investment Card | `SimpleInvestmentCard` | Summary card |
| Investment Goals | `InvestmentGoals` + `SetGoalDialog` | Set and track targets |
| Investment Packages | `InvestmentPackageSheet` | Available tiers |
| **Accounts** | | |
| Accounts List | `SimpleAccountsList` | Investment accounts with status badges |
| Account Details | `AccountDetailsDialog` | Full account info |
| Create Account | `CreateAccountDialog` | New account setup |
| Fund Account | `FundAccountDialog` | Deposit into account |
| Withdraw | `InvestmentWithdrawButton` + `WithdrawAccountDialog` | Request withdrawals (90-day notice) |
| Payout Method | `PayoutMethodDialog` | Configure payout method |
| Wallet Details | `WalletDetailsSheet` | Detailed wallet view |
| **Opportunities** | | |
| Virtual Houses | `VirtualHousesFeed` + `VirtualHouseCard` + `VirtualHouseDetailsSheet` | Anonymized funded houses |
| House Opportunities | `HouseOpportunities` | Available funding opportunities |
| Opportunity Summary | `OpportunitySummaryCard` + `OpportunityHeroButton` | Investment opportunity overview |
| Opportunity Tabs | `ModernOpportunityTabs` | Browse by category |
| Rent Categories | `RentCategoryFeed` | Rent requests by tier |
| Credit Requests | `CreditRequestsFeed` | Incoming credit requests |
| Tenants Needing Rent | `TenantsNeedingRent` + `SimpleTenantsList` | Anonymized tenants needing support |
| Funder Opportunities | `FunderCapitalOpportunities` | Capital deployment opportunities |
| **Financial** | | |
| Fund Rent | `FundRentDialog` | Direct pool contribution |
| Funding Pool | `FundingPoolCard` | Pool balance and health |
| ROI Earnings | `ROIEarningsCard` | Monthly ROI display |
| Interest History | `InterestPaymentHistory` | Payout history |
| Funded History | `FundedHistory` | Past funding records |
| Funding Milestones | `FundingMilestones` | Achievement milestones |
| My Requests | `MyInvestmentRequests` | Track request status |
| Request Manager Invest | `RequestManagerInvestDialog` | Request managed investment |
| Pay Landlord | `PayLandlordDialog` | Direct landlord payment |
| Merchant Codes | `MerchantCodePills` | Quick payment codes |
| **Social** | | |
| Leaderboard | `SupporterLeaderboard` + `SupporterROILeaderboard` | Rankings |
| Referral Stats | `SupporterReferralStats` | Referral performance |
| Share Links | `ShareSupporterLink` + `ShareCalculatorLink` | Social sharing |
| Calculator Share | `CalculatorShareCard` | Share calculator |
| Invite Card | `ModernInviteCard` | Recruit supporters |
| **System** | | |
| Notifications | `NotificationBell` + `NotificationsModal` + `SupporterNotificationsFeed` | Notification system |
| User Profile | `UserProfileDialog` | Profile view |
| Floating Portfolio | `FloatingPortfolioButton` | Quick portfolio FAB |
| Menu | `SupporterMenuDrawer` | Navigation drawer |
| Tenant Details | `TenantRequestDetailsDialog` | Anonymized tenant request |
| **Legal** | | |
| Agreement Banner | `SupporterAgreementBanner` | Persistent until accepted |
| Agreement Modal | `SupporterAgreementModal` | 12-month agreement with download/print |
| Agreement Card | `SupporterAgreementCard` | Status display |
| Locked Overlay | `LockedOverlay` | Blocks funding until agreement accepted |
| Accepted Badge | `AgreementAcceptedBadge` | Confirmation after acceptance |

### Key Pages

- `/opportunities` — Full opportunity browser
- `/supporter-earnings` — Detailed earnings
- `/investment-portfolio` — Full portfolio
- `/calculator` — Public investment calculator
- `/investor-portfolio-public` — Public portfolio view
- `/angel-pool` — Angel pool investment
- `/angel-pool-agreement` — Angel pool agreement

### Design

- **Glassmorphism**: Frosted glass effects on hero cards
- **Inactivity Lock Screen**: Glassmorphism overlay with `backdrop-blur-2xl`, `backdrop-saturate-150`, `bg-background/70` opacity — locks session after inactivity, requires password re-entry
- **Mesh gradients**: Primary color gradient backgrounds
- **Animated ROI indicators**: Framer Motion animations
- **Haptic feedback**: `hapticTap` and `hapticSuccess`
- **Trust signals**: Verification badges, professional typography
- **Mobile-first**: Optimized for 240px–390px screens with 44px touch targets
- **Dark mode**: Full support via semantic design tokens

---

## 8. Manager Dashboard

**Route:** `/dashboard` (role: manager)  
**Layout:** Sidebar-based with mobile-optimized menu

### Components

| Feature | Component | Description |
|---------|-----------|-------------|
| **User Management** | | |
| User Profiles | `UserProfilesTable` | Searchable, filterable user list |
| User Details | `UserDetailsDialog` | Full user profile with ledger, wallet, roles |
| User Counts | `UserCountsSummary` + `CompactUserStats` | Role-based statistics |
| Quick Role Editor | `QuickRoleEditor` + `MobileRoleEditor` + `InlineRoleToggle` | Rapid role assignment |
| Bulk Role | `BulkAssignRoleDialog` + `BulkRemoveRoleDialog` | Mass role operations |
| Bulk WhatsApp | `BulkWhatsAppDialog` | Mass communication |
| Inactive Outreach | `InactiveUsersReachOutDialog` | Re-engagement |
| Duplicate Detection | `DuplicatePhoneUsersSheet` | Fraud detection |
| Role History | `RoleHistoryViewer` | Role change audit trail |
| Simple User Card | `SimpleUserCard` | Compact user summary |
| Quick User Lookup | `QuickUserLookup` | Fast user search |
| Password Reset | `PasswordResetGuide` | Reset guide |
| Dashboard Permissions | `DashboardPermissionsTab` | Permission management |
| PIN Screen | `ManagerPinScreen` | Security PIN |
| **Financial Operations** | | |
| KPI Strip | `ManagerKPIStrip` + `ManagerKPIDetailDrawer` | Key financial metrics |
| Financial Overview | `FinancialOverview` + `FinancialCharts` + `FinancialAlerts` | Platform financial health |
| Ledger Summary | `ManagerLedgerSummary` | Aggregate ledger view |
| General Ledger | `GeneralLedger` + `DayGroupedLedger` | Full ledger browser |
| Banking Ledger | `ManagerBankingLedger` | Banking operations |
| Financial Statements | `FinancialStatementsPanel` | Income, cash flow, balance sheet |
| Fund Flow Tracker | `FundFlowTracker` | Capital movement visualization |
| Fund Edit History | `FundEditHistory` | Investment edit audit |
| Period Comparison | `PeriodComparison` | Period-over-period analysis |
| **Approval Workflows** | | |
| Pending Rent | `PendingRentRequestsWidget` | Approve/reject rent facilitations |
| Approved Funding | `ApprovedRequestsFundingWidget` | Deploy pool funds |
| Rent Requests | `RentRequestsManager` | Full lifecycle management |
| Deposits | `ManagerDepositsWidget` + `DepositRequestsManager` | Approve deposits |
| Deposit Analytics | `DepositAnalytics` | Deposit trends |
| Deposit/Rent Audit | `DepositRentAuditWidget` | Cross-reference |
| Wallet Operations | `PendingWalletOperationsWidget` | Approve proxy investments |
| Investment Requests | `PendingInvestmentRequestsWidget` | Approve supporter requests |
| Pending Invites | `PendingInvitesWidget` | Manage activation invites |
| Pending Sellers | `PendingSellerApplicationsWidget` | Seller applications |
| Loans | `LoanApplicationsManager` | Approve/reject loans |
| Withdrawals | `WithdrawalRequestsManager` | Process withdrawals |
| Commissions | `AgentCommissionPayoutsManager` | Agent commission cashouts |
| Payment Confirmations | `PaymentConfirmationsManager` | Verify payments |
| Payment Proofs | `PaymentProofsManager` | Review evidence |
| **Agent Oversight** | | |
| Float Manager | `AgentFloatManager` | Agent capital limits |
| Earnings Overview | `AgentEarningsOverview` | System-wide earnings |
| Agent Details | `AgentDetailsDialog` | Deep-dive performance |
| Collections | `AgentCollectionsWidget` | Monitor field collections |
| Issue Advance | `IssueAdvanceSheet` | Capital advances |
| Paid Agents | `PaidAgentsHistory` | Commission payout history |
| **Supporter Management** | | |
| Pool Balance | `SupporterPoolBalanceCard` | Pool health: balance, deployed, reserve |
| Create Supporter | `CreateSupporterDialog` + `CreateSupporterWithAccountDialog` | Onboard supporters |
| Supporter Invites | `SupporterInvitesList` | Invitation tracking |
| ROI Trigger | `SupporterROITrigger` | Manual ROI processing |
| Monthly Rewards | `MonthlyRewardsTrigger` | Manual reward payouts |
| Investment Accounts | `InvestmentAccountsManager` | Manage accounts |
| Create/Edit/Fund | `CreateInvestmentAccountDialog` + `EditInvestmentAccountDialog` + `FundInvestmentAccountDialog` | Account CRUD |
| Edit History | `InvestmentEditHistoryDialog` | Investment audit trail |
| Manager Requests | `ManagerInvestmentRequestsSection` | Manager-side requests |
| Opportunity Form | `OpportunitySummaryForm` | Create/edit opportunities |
| Reserve Panel | `ReserveAllocationPanel` | Reserve configuration |
| Buffer Panel | `BufferAccountPanel` + `BufferTrendChart` | Solvency buffers |
| Renew Portfolio | `RenewPortfolioDialog` | Portfolio renewal |
| **Platform Tools** | | |
| Hub Cards | `ManagerHubCards` | Quick navigation |
| Quick Actions | `MobileQuickActions` + `QuickActionsDropdown` + `QuickUserActions` | Rapid actions |
| Floating Actions | `FloatingUserActions` + `FloatingDepositsWidget` | FABs |
| Activity Manager | `ActivityManager` | Activity feed |
| Active Users | `ActiveUsersCard` | Online tracking |
| Receipt Management | `ReceiptManagement` | Receipt verification |
| Printable Receipt | `PrintableReceiptSheet` | Generate receipts |
| Record Merchant | `RecordMerchantPayment` | Merchant transactions |
| Add Balance | `AddBalanceDialog` | Direct balance additions |
| Orders | `OrdersManager` | Marketplace orders |
| Vendor Analytics | `VendorAnalytics` | Vendor stats |
| User Locations | `UserLocationsManager` | Geographic distribution |
| Welile Homes | `WelileHomesSubscriptionsManager` + `WelileHomesWithdrawalsManager` | Savings management |
| Subscription Monitor | `SubscriptionMonitorWidget` | Auto-charge status |
| My Performance | `MyPerformanceCard` | Manager self-performance |
| Daily Report | `DailyReportMetrics` | End-of-day summary |
| Tips | `ManagerTip` | Contextual tips |
| Force Refresh | `ForceRefreshManager` | Cache clearing |
| Chromecast | `ChromecastButton` | Cast to TV |
| Audit Log | `AuditLogViewer` | Full audit trail |
| **AI** | | |
| AI Brain | `AIBrainDashboard` | AI-powered insights |
| AI Recommendations | `AIRecommendationCard` | AI suggestions |
| AI Session History | `AISessionHistory` | Interaction logs |
| AI User Report | `AIUserExperienceReport` | UX analysis |

### Key Pages

- `/user-management` — Full user management
- `/deposits-management` — Deposit approval with pagination
- `/financial-statement` — Financial statements
- `/audit-log` — Audit trail
- `/transaction-history` — Transaction browser
- `/staff-portal` — Staff portal
- `/tv-dashboard` — TV display mode

---

## 9. Super Admin Dashboard

**Route:** `/admin/dashboard`

Full access to all Manager features + system configuration + role assignment with authorization codes.

---

## 10. CEO Dashboard

**Route:** `/ceo/dashboard`  
**Layout:** `ExecutiveDashboardLayout`

### KPI Grid (8 Cards)

| KPI | Source | Description |
|-----|--------|-------------|
| Total Users | `profiles` count | All registered users |
| Tenants Funded | `rent_requests` (funded statuses) | Successfully financed tenants |
| Rent Financed | Sum of `rent_amount` | Total UGX deployed |
| Total Landlords | `landlords` count | Registered property owners |
| Partners/Investors | `investor_portfolios` count | Investment portfolios |
| Platform Revenue | `general_ledger` (platform_fee credits) | Cumulative revenue |
| Rent Repaid | Sum of `amount_repaid` | Total repayments |
| Active Agents | Distinct `agent_id` in `agent_earnings` | Earning agents |

### Sidebar Sections

- Platform Overview — 8-KPI grid + charts + recent rent requests
- Revenue & Growth — Revenue trends, capital raised, repayment tracking
- Users & Coverage — User base metrics, geographic coverage
- Financial Health — Solvency indicators, buffer status
- Staff Performance — Audit logs, idle alerts, SLA compliance

### Sub-Components

| Component | Description |
|-----------|-------------|
| `CEODashboard` | Main overview with KPIs, growth metrics, charts |
| `TenantOpsDashboard` | Tenant funnel and health |
| `AgentOpsDashboard` | Agent performance and coverage |
| `LandlordOpsDashboard` | Landlord engagement |
| `PartnersOpsDashboard` | Supporter capital and ROI |
| `StaffPerformancePanel` | Staff activity and SLA |
| `KPICard` | Standardized metric display |
| `ExecutiveDataTable` | Sortable, searchable executive data |

### CEO Drilldown Pages

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

## 11. COO Dashboard

**Route:** `/coo/dashboard`  
**Layout:** `ExecutiveDashboardLayout`

### Components

| Feature | Component | Description |
|---------|-----------|-------------|
| Financial Metrics | `FinancialMetricsCards` | Rent collected, payments today/month, wallets, approvals |
| Transactions | `FinancialTransactionsTable` | Searchable ledger with CSV export, multi-filters |
| Agent Collections | `AgentCollectionsOverview` | Field activity: tracking IDs, GPS, MoMo, KPIs |
| Wallet Monitoring | `WalletMonitoringPanel` | Master wallet, agent wallets, settlements |
| Payment Analytics | `PaymentModeAnalytics` | MTN/Airtel/Cash/Wallet distribution charts |
| Reports | `FinancialReportsPanel` | Downloadable revenue summaries |
| Alerts | `FinancialAlertsPanel` | Anomaly detection (payments > 2M UGX) |
| Withdrawal Approvals | `COOWithdrawalApprovals` | Partner withdrawal processing (wallet withdrawals handled by Financial Ops) |
| Partner Withdrawals | `COOPartnerWithdrawalApprovals` | Partner withdrawal queue |
| Partners Management | `COOPartnersPage` | Full partner oversight with search, filters, CSV, bulk import |
| Partner Import | `PartnerImportDialog` | Excel bulk import |
| Contribution Dates | `UpdateContributionDatesDialog` | Update portfolio dates |
| Detail Layout | `COODetailLayout` | Consistent detail pages |
| Data Table | `COODataTable` | Reusable sortable/filterable table |

### Key COO Features

- Transaction authorization (separate approval from disbursement)
- Manual ROI and referral payout triggers
- Solvency governance (Coverage Ratio > 1.2x)
- Identity & compliance verification
- Invest for Partner (via `coo-invest-for-partner` edge function)
- Payout day override per portfolio (1–28)
- Account suspension via `frozen_at` field
- Bulk partner import from Excel
- Bulk activate pending portfolios
- Portfolio Compound with Preview Dialog — COO/Partner Ops can compound ROI directly from portfolio view (replaces WhatsApp button). Shows confirmation dialog with current principal, ROI amount, and new principal before executing. Updates principal only; does NOT advance `next_roi_date`.
- OVERDUE Badge — Portfolios with `next_roi_date` in the past display a red "OVERDUE" badge in the Nearing Payouts section. Dates no longer auto-roll forward.

---

## 12. CFO Dashboard

**Route:** `/cfo/dashboard`  
**Layout:** `ExecutiveDashboardLayout`

### Components

| Feature | Component | Description |
|---------|-----------|-------------|
| Reconciliation | `CFOReconciliationPanel` | Compare wallets vs ledger, detect gaps |
| Partner Payouts | `CFOPartnerPayoutProcessing` | Partner payout processing |
| Receivables Tracker | `CFOReceivablesTracker` | Track outstanding receivables |
| Revenue & Expense | `RevenueExpenseDashboard` | Revenue vs expense analysis |
| Daily Cash Position | `DailyCashPositionReport` | Daily cash status |
| Platform vs Wallet | `PlatformVsWalletSummary` | Platform totals vs wallet totals |
| Channel Balance | `ChannelBalanceTracker` | MTN/Airtel/Cash channel balances |
| Threshold Alerts | `ThresholdAlerts` | Financial threshold warnings |
| Pending Top-Ups | `PendingPortfolioTopUps` | Pending portfolio top-ups |
| Payroll | `PayrollPanel` | Staff payroll management |
| Direct Credit | `DirectCreditTool` | Direct wallet credit tool |
| Agent Reconciliation | `AgentCashReconciliation` | Agent cash reconciliation |
| Batch Payout | `BatchPayoutProcessor` | Batch payout processing |
| Cashout Agent | `CashoutAgentManager` + `CashoutAgentActivity` | Cashout agent management |
| Financial Agents | `FinancialAgentsPanel` | Agent financial overview |
| Proxy Agent Manager | `ProxyAgentManager` | Manage proxy agents |
| Disbursement Registry | `DisbursementRegistry` | Disbursement records |
| Delivery Pipeline | `DeliveryPipelineTracker` | Delivery tracking |
| Landlord Ops Review | `LandlordOpsPayoutReview` | Landlord payout review |
| User Search | `UserSearchPicker` | Quick user lookup |

### Key CFO Features

- Income Statement, Balance Sheet, Cash Flow views
- Compact currency display (3.5M, 120K) with tooltips
- CSV export for offline auditing
- Mandatory CFO sign-off for: ROI payouts, commissions
- Buffer/escrow monitoring
- Coverage ratio and liquidity indicators
- **Note:** Wallet withdrawal approvals are now handled entirely by Financial Ops (single-step) — CFO no longer has a separate withdrawal approval queue

---

## 13. CTO Dashboard

**Route:** `/cto/dashboard` or `/executive-hub?tab=cto`  
**Component:** `CTODashboard`

### KPI Cards

| Metric | Description |
|--------|-------------|
| DB Response Time | Live latency probe (ms) |
| Active Users (7d) | Users active in past week |
| Total Users | Total registered accounts |
| Edge Functions | Count of deployed functions |
| DB Tables | Total database tables |
| Realtime Status | Realtime connection health |
| Storage Usage | File storage consumption |
| Error Rate | System error frequency |

### System Infrastructure Monitoring

- API endpoint testing
- Database connection health
- Edge function deployment status
- Security log viewer (`SystemLogsViewer`)
- Developer tools and diagnostics

---

## 14. CMO Dashboard

**Route:** `/executive-hub?tab=cmo`  
**Component:** `CMODashboard`

### KPI Grid (4 Cards)

| KPI | Description |
|-----|-------------|
| Total Users | Platform-wide user base |
| Monthly Signups | Current month registrations with growth trend |
| Referral Signups | Users acquired via referral programme |
| Conversion Rate | Referral signups ÷ total users |

### Charts (6-Month Window)

- **Signup Growth** — Area chart of monthly registrations
- **Referral Performance** — Bar chart of referral-attributed signups

---

## 15. CRM Dashboard

**Route:** `/executive-hub?tab=crm`  
**Component:** `CRMDashboard`

### KPI Grid (6 Cards)

| KPI | Description |
|-----|-------------|
| Total Inquiries | All notifications/messages sent |
| Unread | Messages not yet seen (red urgency indicator) |
| Unique Users | Individual users with communications |
| Support Tickets | User-initiated help requests |
| Warning Alerts | System-generated warnings |
| Read Rate | Message open percentage |

### Data Table

Dual-filterable table with type filter (Support/Inquiry/Alert/Info) and status filter (Read/Unread).

---

## 16. Executive Hub

**Route:** `/executive-hub`  
**Access:** CEO, CTO, CFO, COO, CMO, CRM, Super Admin, Manager

Consolidates all 8 executive dashboards into a single tabbed interface with `?tab=` parameter routing.

### Additional Executive Components

| Component | Description |
|-----------|-------------|
| `TenantDetailPanel` | Deep tenant analytics |
| `TenantBehaviorDashboard` | Behavior patterns |
| `TenantOverviewList` | Tenant listing |
| `TenantRentCollector` | Collection interface |
| `TenantAgentLinker` | Link tenants to agents |
| `TenantTransferPanel` | Transfer tenants |
| `AgentDirectory` | Agent listing |
| `AgentTaskManager` | Task assignment |
| `AgentEscalationQueue` | Escalation handling |
| `AgentPerformanceTiers` | Performance tiers |
| `AgentLifecyclePipeline` | Agent lifecycle |
| `AgentProximitySelector` | GPS-based agent selection |
| `AgentTenantSearch` | Cross-reference search |
| `AgentTenantConnector` | Link agents/tenants |
| `AgentAlertFeed` | Agent alerts |
| `AgentOpsBrief` | Operations brief |
| `PartnerDirectory` | Partner listing |
| `PartnerCapitalFlow` | Capital movement |
| `PartnerChurnAlerts` | Churn detection |
| `PartnerOpsBrief` | Partner operations |
| `PartnerOpsWithdrawalQueue` | Withdrawal processing |
| `RentPipelineQueue` + `RentPipelineTracker` | Rent pipeline |
| `DailyPaymentTracker` | Daily payment monitoring |
| `MissedDaysTracker` | Missed payment tracking |
| `RepaymentTrendChart` | Repayment trends |
| `ROIPaymentHistory` + `ROITrendsPage` | ROI analytics |
| `ListingBonusApprovalQueue` | Listing bonus approvals |
| `VacancyAnalytics` | Vacancy analysis |
| `ApprovalHistoryLog` | Approval audit trail |
| `DeleteHistoryViewer` | Deletion audit |
| `DeleteRentRequestDialog` | Rent request deletion |
| `RentAdjustmentDialog` | Rent amount adjustment |
| `ChangeMaturityDateDialog` | Maturity date changes |
| `DashboardGuide` | Interactive guide |
| `UserProfileSheet` | User profile sheet |

---

## 17. Wallet System

Every user has a single wallet. Wallet balances are **derived from the general ledger** via the `sync_wallet_from_ledger` trigger — never edited directly.

### Wallet UI (`FullScreenWalletSheet`)

**Always Visible:**
- **Deposit** — Add money via Mobile Money (MTN/Airtel merchant codes)
- **Withdraw** — Request withdrawal (subject to guardrails and approval pipeline)

**Collapsible "Pay for Anything" Section:**
- **Send** — Transfer money to another Welile user
- **Request** — Request money from another user
- **12-Category Payment Grid** (4 columns): Food, Groceries, Fuel, Transport, Hotel, Clinic, Mechanic, Restaurant, Electricity, Water, Salon, School

### Wallet Components

| Component | Description |
|-----------|-------------|
| `WalletCard` | Compact wallet display |
| `CollapsibleWalletCard` | Expandable wallet card |
| `FloatingWalletButton` | FAB for wallet access |
| `AnimatedBalance` | Animated balance display |
| `WalletBreakdown` | Balance breakdown |
| `WalletStatement` + `WalletLedgerStatement` | Transaction statements |
| `LedgerEntryDetailDrawer` | Detailed ledger entry view |
| `RecentBalanceChanges` | Recent balance movements |
| `RecentAutoCharges` | Recent auto-deductions |
| `TransactionReceipt` | Receipt generation |
| `WalletDisclaimer` | Licensed & Regulated badge |
| `BillPaymentDialog` | Utility/service payments |
| `FoodMarketDialog` | Food/grocery ordering |
| `SendMoneyDialog` | User-to-user transfer |
| `RequestMoneyDialog` | Request money from user |
| `PayLandlordDialog` | Direct landlord payment |
| `PendingRequestsDialog` | Pending money requests |
| `UserDepositRequests` | Deposit request history |
| `UserWithdrawalRequests` | Withdrawal request tracking |
| `AgentRentRequestsWalletSection` | Agent rent requests in wallet |
| `MyReferralsCount` | Referral count display |

### Trust Signals

- **Operator Badges**: MTN (yellow "M"), Airtel (red "A")
- **Traffic-Light Balance**: 🟢 ≥ 50K, 🟡 1–49K, 🔴 0
- **Last Synced Label**: With offline indicator (📴)

---

## 18. Deposit Flow

**Component:** `DepositDialog`  
**8-Step Guided Process:**

| Step | Description |
|------|-------------|
| 1 | Interactive instructions with swipeable slides |
| 2 | Select provider — MTN or Airtel |
| 3 | Display merchant code — `090777` (MTN) / `4380664` (Airtel) |
| 4 | Enter amount — Quick chips: UGX 50K, 100K, 200K, 500K |
| 5 | Enter Transaction ID (TID) — Real-time duplicate validation |
| 6 | Select transaction date/time — Limited to last 7 days |
| 7 | Add optional narration/notes |
| 8 | Success summary |

### Agent Deposit Modes

**Mode 1 — "I Collected Cash":** Agent wallet debited instantly, customer credited, triggers auto-repayment.

**Mode 2 — "Customer Paid Directly":** TID-only submission, no wallet deduction, creates pending entry for manager verification.

### Approval Pipeline

```
User submits → Manager reviews → Approved/Rejected
```

---

## 19. Withdrawal Flow

**Component:** `WithdrawRequestDialog`

### Guardrails

| Rule | Detail |
|------|--------|
| Working Hours Only | Mon–Fri 8AM–5PM, Sat 8AM–1PM (EAT) |
| Minimum Balance | UGX 5,000 must remain after withdrawal |
| Daily Limit | Maximum daily withdrawal enforced |

### Pre-Deduction at Request Time

When a user submits a withdrawal request, the requested amount is **immediately deducted** from their wallet balance via a `cash_out` ledger entry with `category: 'withdrawal_pending'` and `transaction_group_id: wallet-withdraw-{withdrawalId}`. This ensures funds are held during the approval process and prevents double-spending.

### Single-Step Approval Pipeline

```
Requested (funds held) → Financial Ops Approve & Complete (enter TID/Receipt/Bank Ref)
```

Financial Operations reviews the request, selects the actual payment method used (MTN MoMo, Airtel Money, Bank Transfer, or Cash), and enters the corresponding Transaction ID (TID), Bank Reference, or Receipt Number to complete the request directly. Status transitions from `pending` → `approved` in one step.

**Tracked via:** `WithdrawalStepTracker` (2-step: Requested → Approved & Paid)

### Rejection & Idempotent Refund

If a withdrawal is rejected, the system automatically refunds the pre-deducted amount via a `cash_in` ledger entry with `category: 'withdrawal_reversal'` and `transaction_group_id: wallet-reject-{withdrawalId}`. The refund is **idempotent** — the system checks for an existing entry with the same `transaction_group_id` before inserting, preventing double refunds on retries or edge function re-runs.

For float withdrawals, the same idempotency pattern applies using `transaction_group_id: float-reject-{withdrawalId}`.

### Key Guarantees

- **No double deductions**: Single `cash_out` at request time with unique `transaction_group_id`
- **No double refunds**: Existence check on `transaction_group_id` before inserting reversal
- **Ledger traceable**: Every wallet change tied to a ledger entry
- **Safe against retries**: Edge function re-runs skip already-processed refunds

**Investment withdrawals** pause rewards immediately and are subject to **90-day notice period**.

---

## 20. Rent Facilitation Flow

### End-to-End Process

**Step 1 — Request:** Tenant/agent submits rent request with landlord details, property address, duration, utility meters.

**Step 2 — Agent Verification:** Field agent visits property, captures GPS, verifies landlord identity with PINs.

**Step 3 — Manager Approval:** Manager reviews in "Pending Rent Requests" queue, checks risk factors.

**Step 4 — Pool Deployment:** System creates subscription, posts obligation to ledger, credits landlord wallet via routing fallback:
1. Landlord's wallet (matched by phone)
2. Caretaker's wallet (if landlord isn't on platform)
3. Agent's wallet (as cash-out proxy)

**Step 5 — Repayment:** Daily auto-deductions from tenant wallet, or agent-collected cash.

---

## 21. Access Fee & Compounding Logic

### Supported Rates

| Rate | Label |
|------|-------|
| 23% | Low (shorter durations, returning tenants) |
| 28% | Medium (standard facilitation) |
| 33% | High (higher-risk or longer durations) |

### Formula

```
accessFee = rentAmount × ((1 + monthlyRate)^(durationDays / 30) − 1)
```

### Request Fee

| Rent Amount | Fee |
|-------------|-----|
| ≤ UGX 200,000 | UGX 10,000 |
| > UGX 200,000 | UGX 20,000 |

### Total Repayment

```
totalRepayment = rentAmount + accessFee + requestFee
dailyRepayment = ceil(totalRepayment / durationDays)
```

---

## 22. Repayment & Auto-Charge System

### Daily Auto-Deduction (06:00 UTC via pg_cron)

1. Identify active subscriptions where `next_charge_date` ≤ today
2. Deduct `charge_amount` from tenant wallet
3. If insufficient → fallback to linked agent's wallet
4. If agent insufficient → record as accumulated debt
5. For no-smartphone tenants → skip tenant, charge agent directly

### Deposit-Triggered Auto-Repayment

1. Clear outstanding rent balance immediately
2. Clear accumulated debt
3. Pre-pay future installments if surplus remains
4. Reset grace period tracker

---

## 23. Agent Earnings & Commission Structure

### 10% Rent Repayment Commission (via `credit_agent_rent_commission` RPC)

Every rent repayment triggers a **10% total commission** split across up to 3 agent roles:

| Role | Share | Condition |
|------|-------|-----------|
| Source Agent | 2% | Agent who originally registered the tenant |
| Tenant Manager | 8% | Agent currently managing the tenant (if no recruiter) |
| Tenant Manager | 6% | Agent currently managing the tenant (if recruiter exists) |
| Recruiter Override | 2% | Agent who recruited the Tenant Manager (from manager's share) |

**Concrete Example:** Tenant repays UGX 100,000 → Total commission = UGX 10,000
- Source Agent: UGX 2,000
- Tenant Manager: UGX 8,000 (or UGX 6,000 if recruiter exists)
- Recruiter: UGX 2,000 (only if recruiter exists, taken from manager's share)

### Fixed Event Bonuses (via `credit_agent_event_bonus` RPC)

| Activity | Reward |
|----------|--------|
| Verified house listing | UGX 5,000 |
| Landlord location verification | UGX 5,000 |
| Rent application facilitation | UGX 5,000 |
| Sub-agent registration | UGX 10,000 |
| Tenant replacement | UGX 20,000 |
| Service Centre setup (verified & CFO-approved) | UGX 25,000 |

### Double-Entry Marketing Expense Pattern

All agent earnings (commissions and bonuses) are classified as platform **marketing expenses**. Every agent wallet credit is paired with a corresponding platform debit:

```
Platform Side (Debit):
  direction: cash_out
  category: marketing_expense
  ledger_scope: platform
  description: "Marketing expense: Agent commission on repayment"

Agent Side (Credit):
  direction: cash_in
  category: agent_commission
  ledger_scope: wallet
  description: "Commission on repayment: Source agent 2%"

Both entries share the same transaction_group_id for full auditability.
The set_ledger_scope() trigger automatically routes marketing_expense → platform scope.
```

### Other Commissions

| Action | Reward |
|--------|--------|
| Proxy investment facilitation | 2% commission |
| Landlord management fee (non-smartphone landlords) | 2% |

### Career Path

| Milestone | Reward |
|-----------|--------|
| Team Leader (2+ sub-agents) | Cash advances (UGX 300K–30M) |
| 50 repaying tenants | Electric Bike |

### Agent Commission Benefits Page (UI)

**Route:** `/agent-commission-benefits` (accessible from agent hamburger menu, icon color `#7214c9`)

**Purpose:** Plain-language page explaining the full commission model with concrete money examples so agents understand exactly how they earn.

**Content:** How You Earn section, Commission Split Table, Event Bonuses Table, Career Path milestones.

**WhatsApp Sharing:** Uses `navigator.share` Web Share API (mobile) with `https://wa.me/?text=...` fallback (desktop). Shares structured text summary of commission model.

**Branding Assets:** High-resolution "Welile Service Centre" logo and poster available for download and printing.

**Printing Instructions:** On-page step-by-step guide with colour codes (Purple `#7214c9`, White `#FFFFFF`, Black `#000000`), paper sizes (A3/A2 for poster, A4 for logo), and mounting advice.

**Service Centre Setup Submission & Payout Pipeline:**
```
Agent submits photo + GPS (pending) → Agent Ops verifies (verified) → CFO approves & pays UGX 25,000 (paid)
```
- Submission form: photo upload, GPS capture, location name, auto-filled agent details → `service_centre_setups` table
- Agent Ops Dashboard: `ServiceCentreVerificationQueue` — verify or reject with mandatory reason
- CFO Dashboard: `ServiceCentrePayoutApproval` — calls `credit_agent_event_bonus(p_event_type='service_centre_setup')` for UGX 25,000
- Ledger: Platform debit (`marketing_expense`) + Agent credit (`agent_commission`) via shared `transaction_group_id`
- Database: `service_centre_setups` table with RLS; Storage: `service-centre-photos` bucket (public)

---

## 24. Agent Advance (Credit) System

- **Access Fee:** 33% monthly compounding
- **Registration Fee:** UGX 10K (≤ 200K principal) or UGX 20K (> 200K)
- **Repayment Periods:** 7, 14, 30, 60, or 90 days
- **Daily deduction** at 05:00 UTC from agent wallet
- **Shortfall compounds** at ~0.96%/day

### Risk Monitoring (Balance-to-Principal Ratio)

| Status | Condition |
|--------|-----------|
| 🟢 Healthy | ≤ 1.0x |
| 🟡 Caution | > 1.5x |
| 🔴 Critical | > 3.0x or Overdue |

---

## 25. Supporter Investment Model

### Plans

| Plan | Monthly ROI |
|------|-------------|
| Standard | 15% |
| Premium | 20% |

### Reward Formula

```
monthlyReward = investmentAmount × (roiPercentage / 100)
```

### Payout Rules

1. **30-day working period** before first payout
2. **Dual-mode:** Strict 30-day cycle OR fixed calendar day (1st–28th, COO-configured)
3. **Withdrawal:** Pauses rewards immediately, 90-day notice period

### Causal Date Advancement Policy

- `next_roi_date` does **NOT** auto-roll on missed payments — overdue dates remain visible
- `next_roi_date` does **NOT** advance when COO initiates a payout — it stays unchanged until CFO approves
- `next_roi_date` advances **+1 month ONLY** when CFO approves via `approve-wallet-operation` edge function
- **Compounding** updates principal but preserves the payout date (`next_roi_date` unchanged)
- Missed payments show as **OVERDUE** in the COO dashboard until sequentially processed (one approval = one month advanced)

### Privacy

Supporters NEVER see tenant names, landlord details, agent info, or phone numbers. Only Virtual Houses, payment health, and portfolio performance.

---

## 26. Rent Management Pool

### Metrics

| Metric | Definition |
|--------|-----------|
| Pool Balance | Total capital available |
| Total Deployed | Sum of all disbursements |
| 15% Reserve | Locked for monthly rewards |
| Deployable | Pool Balance − 15% Reserve |

### Rules

- Only "Ready to Fund" requests (where `funded_at IS NULL`)
- **Pre-payout Liquidity Gate:** Blocked if pool drops below 15% reserve
- Double-funding prevention via `funded_at` timestamp

### Deployment Atomic Transaction

1. Ledger entry: `pool_rent_deployment`
2. Tenant obligation created
3. Auto-charge subscription created
4. Agent Approval Bonus (UGX 5,000)
5. Landlord wallet credited (via routing fallback)
6. SMS notifications sent

---

## 27. Proxy Investment Flow

### Agent-Initiated

1. Agent wallet **immediately debited**
2. Portfolio created: `pending_approval`
3. Partner credit + agent 2% commission queued
4. Manager/COO approves → ledger entries → wallet sync → portfolio active
5. **If rejected:** Portfolio cancelled, agent refunded

### COO-Initiated

- Via `coo-invest-for-partner` edge function
- Minimum UGX 50,000
- Double-entry ledger with optimistic locking
- User-facing: "Welile Operations" branding
- Ledger category: `coo_proxy_investment`

---

## 28. Credit Access System

### Fee Structure

| Fee | Rate |
|-----|------|
| Platform Fee | 5% monthly (compounding) |
| Funder Interest | Variable (optional) |
| Agent Commission | 5% of total repayment |

### Credit Limit Factors

- Verified rent payment history
- Number of verified receipts
- Platform ratings
- Funded rent requests
- Landlord rent history
- **Maximum cap:** UGX 30,000,000

### Statuses

`pending` → `approved` → `active` → `repaid` / `defaulted` / `rejected`

---

## 29. Welile Homes Savings Program

- **Auto-save:** 10% of every rent payment
- **Growth Rate:** 5% monthly compound interest
- **Withdrawal:** Only for land purchase, house purchase, or mortgage

### Pages

- `/welile-homes` — Tenant savings view
- `/welile-homes-dashboard` — Manager oversight

---

## 30. Landlord Guaranteed Rent Program

- Platform charges **10% fee** → redirected to tenant's Welile Homes savings
- If tenant defaults → **Welile pays landlord** → tenant owes amount + 28% access fee
- Agents earn **2% commission** on subsequent rent payments

---

## 31. Double-Entry Ledger System

### Account Groups

| Group | Code | Purpose | Allows Negative |
|-------|------|---------|-----------------|
| User Owned | USER_OWNED | User wallets | No |
| Obligation | OBLIGATION | Debts/commitments | Yes |
| System Control | SYSTEM_CONTROL | Buffer/escrow | Varies |
| Revenue | REVENUE | Deferred/recognized | Varies |
| Expense | EXPENSE | Costs/rewards (includes `marketing_expense`) | Varies |
| Settlement | SETTLEMENT | Banking | Varies |

### How It Works

Every financial action creates **two ledger entries** (debit + credit) that must balance. Wallet sync trigger (`sync_wallet_from_ledger`) automatically adjusts balances only when `transaction_group_id` is set.

### Marketing Expense Category

Agent commissions and bonuses are platform **marketing expenses**. The `set_ledger_scope()` trigger (BEFORE INSERT on `general_ledger`) automatically routes any entry with `category = 'marketing_expense'` to `ledger_scope = 'platform'`, ensuring these costs are tracked on the platform ledger — not the agent's personal wallet.

```
set_ledger_scope() routing:
  marketing_expense → platform scope
  rent_float_funding, landlord_float_payout, agent_advance_* → bridge scope
  all other categories → wallet scope (default)
```

### Transaction Categories (Cash Out)

| Category | Description |
|----------|-------------|
| `marketing_expense` | Platform debit for agent commissions & bonuses |
| `withdrawal_pending` | Pre-deduction at withdrawal request time |
| `withdrawal_reversal` | Refund on rejection (idempotent via `wallet-reject-{id}`) |
| `rent_facilitation_payout` | Landlord rent disbursement |
| `supporter_platform_rewards` | Monthly supporter rewards |
| `operational_expenses` | General operations |
| `wallet_transfer` | Peer-to-peer transfer |
| *(+ 6 more categories)* | See root WELILE_WORKFLOW.md Section 19.5 for full list |

### Key RPCs

| Function | Purpose |
|----------|---------|
| `record_rent_request_repayment()` | Atomic repayment: updates rent_requests, landlords, creates ledger entry |
| `credit_agent_rent_commission()` | 10% commission split with double-entry marketing expense (Source 2% / Manager 8% or 6% / Recruiter 2%) |
| `credit_agent_event_bonus()` | Flat-fee bonus with double-entry marketing expense (params: `p_agent_id`, `p_bonus_type`, `p_amount`, `p_source_table`, `p_source_id`, `p_description`) |

### Corrections

NEVER edit entries. Post **reversing entries** instead.

---

## 32. Edge Functions

### 80+ Backend Functions

#### Authentication & Onboarding
| Function | Description |
|----------|-------------|
| `activate-supporter` | Activate invited accounts with rate limiting |
| `create-supporter-invite` | Generate invite links with temp passwords |
| `register-tenant` | Register new tenants |
| `register-employee` | Register staff |
| `admin-reset-password` | Administrative password reset |
| `bulk-password-reset` | Mass password reset |
| `password-reset-sms` | SMS-based reset |
| `sms-otp` | OTP verification |
| `otp-login` | OTP-based login |
| `vendor-login` | Vendor authentication |
| `whatsapp-login-link` | WhatsApp login links |
| `diagnose-auth` | Auth diagnostics |
| `provision-staff-passwords` | Staff password provisioning |

#### Financial Operations
| Function | Description |
|----------|-------------|
| `agent-deposit` | Process agent cash deposits |
| `agent-withdrawal` | Agent withdrawal requests |
| `approve-deposit` | Manager/COO deposit approval |
| `wallet-transfer` | Wallet-to-wallet transfer |
| `fund-rent-pool` | Supporter → pool transfer (instant) |
| `fund-tenant-from-pool` | Deploy pool funds |
| `fund-tenants` | Bulk tenant funding |
| `auto-charge-wallets` | Daily pg_cron auto-charge |
| `manual-collect-rent` | Manual collection recording |
| `tenant-pay-rent` | Tenant rent payment |
| `cfo-direct-credit` | CFO direct wallet credit |
| `platform-expense-transfer` | Platform expense transfers |
| `seed-test-funds` | Test fund seeding |

#### Investment & Portfolio
| Function | Description |
|----------|-------------|
| `agent-invest-for-partner` | Agent proxy investment (approval-gated) |
| `coo-invest-for-partner` | COO proxy investment |
| `coo-wallet-to-portfolio` | COO wallet→portfolio transfer |
| `create-investor-portfolio` | Direct portfolio creation |
| `portfolio-topup` | Portfolio top-up |
| `manager-portfolio-topup` | Manager-initiated top-up |
| `apply-pending-topups` | Apply pending top-ups |
| `approve-wallet-operation` | Approve pending credits; advances `next_roi_date` +1 month for ROI payout approvals |
| `supporter-account-action` | Supporter account operations |
| `process-investment-interest` | Interest accrual |
| `process-supporter-roi` | ROI payout processing |
| `process-monthly-rewards` | Monthly reward distribution |
| `register-proxy-funder` | Register proxy funder |

#### Rent Facilitation
| Function | Description |
|----------|-------------|
| `approve-rent-request` | Multi-stage rent approval |
| `approve-loan-application` | Loan approval |
| `delete-rent-request` | Manager rent deletion |
| `check-repayment-status` | Check obligations |
| `disburse-rent-to-landlord` | Landlord disbursement |
| `transfer-tenant` | Tenant transfer |
| `reject-withdrawal` | Withdrawal rejection |

#### Agent Operations
| Function | Description |
|----------|-------------|
| `process-agent-advance-deductions` | Daily advance deductions |
| `send-collection-sms` | Collection SMS |
| `fund-agent-landlord-float` | Agent landlord float funding |
| `process-credit-daily-charges` | Daily credit charges |
| `process-credit-draw` | Credit draw processing |
| `import-partners` | Bulk partner import |
| `partner-ops-automation` | Partner operations automation |
| `wallet-deduction` | Financial Ops wallet deduction (mandatory reason, creates ledger + audit entries) |
| `tenant-pay-rent` | Tenant direct rent payment from wallet (validates balance → ledger `cash_out` → `record_rent_request_repayment` RPC → `credit_agent_rent_commission` RPC → fire-and-forget `notify-managers`) |
| `angel-pool-invest` | Angel Pool share investment (max 25,000 shares × UGX 20,000/share, 8% pool equity; validates balance + capacity, records in `angel_pool_investments`, creates `cash_out` ledger entry) |

#### Financial Processing
| Function | Description |
|----------|-------------|
| `batch-process-financials` | Batch financial processing (with idempotency guard) |
| `batch-recalculate-credit-limits` | Batch credit limit recalculation (with empty-run guard) |
| `refresh-daily-stats` | Daily statistics refresh |
| `retry-no-smartphone-charges` | Retry failed charges (8h interval) |
| `export-database` | Database export |

#### Notifications & Communication
| Function | Description |
|----------|-------------|
| `send-push-notification` | Push notification delivery |
| `notify-managers` | Manager notifications |
| `payment-reminder` | Payment due reminders |
| `rent-reminders` | Rent due reminders |
| `send-collection-sms` | Collection SMS |
| `send-funder-statement` | Funder statement emails |
| `send-supporter-agreement-email` | Agreement emails |
| `viewing-confirmation-sms` | Viewing confirmation |
| `vacancy-alerts` | Vacancy notifications |

#### Marketplace & Property
| Function | Description |
|----------|-------------|
| `product-purchase` | Marketplace purchases |
| `vendor-mark-receipt` | Vendor receipt confirmation |
| `scan-receipt` | AI receipt scanning |
| `og-house` | OpenGraph house images |
| `verify-viewing-checkin` | Viewing check-in verification |
| `approve-listing-bonus` | Listing bonus approval |
| `credit-landlord-registration-bonus` | Landlord registration bonus |
| `credit-landlord-verification-bonus` | Landlord verification bonus |
| `credit-listing-bonus` | Listing bonus credit |

#### AI & User Management
| Function | Description |
|----------|-------------|
| `welile-ai-chat` | AI chatbot |
| `user-snapshot` | User data snapshots |
| `validate-payload` | Server-side validation |
| `delete-user` | Account deletion |
| `ussd-callback` | USSD integration |
| `auth-email-hook` | Auth email customization |

---

## 33. Event-Based Architecture

### System Events Table

The `system_events` table provides a traceable audit trail for all financial and operational state transitions.

### 39+ Event Types

**Original (20):** `payment_made`, `payment_missed`, `rent_request_created`, `rent_request_approved`, `rent_request_rejected`, `rent_request_funded`, `funds_added`, `funds_withdrawn`, `risk_score_changed`, `tenant_registered`, `landlord_registered`, `agent_assigned`, `notification_sent`, `subscription_created`, `subscription_cancelled`, `credit_limit_changed`, `deposit_requested`, `deposit_approved_event`, `profile_updated`, `system_alert`

**Added (19):** `deposit_approved`, `deposit_rejected`, `withdrawal_requested`, `withdrawal_approved`, `withdrawal_rejected`, `wallet_transfer`, `portfolio_topup`, `rent_disbursed`, `roi_distributed`, `loan_approved`, `loan_rejected`, `expense_transfer`, `agent_collection`, `role_changed`, `user_deleted`, `password_reset`, `login_success`, `listing_created`, `listing_approved`

### Event Logging

**Shared Helper:** `supabase/functions/_shared/eventLogger.ts`

```typescript
logSystemEvent(adminClient, eventType, userId, entityType, entityId, metadata)
```

Fire-and-forget pattern — errors logged but never block the main transaction.

### DB Triggers (Auto-Logging)

- `deposit_requests` → On status change to 'approved' → `deposit_approved`
- `withdrawal_requests` → On status change → `withdrawal_approved` / `withdrawal_rejected`
- `general_ledger` → On INSERT with `wallet_transfer` category → `wallet_transfer`
- Risk score changes, payments, wallet balance changes, rent request lifecycle

### Retention Policy

- **Financial events retained permanently**: `payment_made`, `funds_added`, `funds_withdrawn`, `deposit_approved`, `withdrawal_approved`, `wallet_transfer`, `portfolio_topup`, `rent_disbursed`, `roi_distributed`, `loan_approved`, `agent_collection`, `expense_transfer`
- **Non-critical events purged after 7 days**: notifications, profile updates, system alerts

### Edge Functions Wired (10 Critical)

| Function | Event Type |
|----------|------------|
| `wallet-transfer` | `wallet_transfer` |
| `approve-deposit` | `deposit_approved` |
| `approve-rent-request` | `rent_request_approved` |
| `disburse-rent-to-landlord` | `rent_disbursed` |
| `portfolio-topup` | `portfolio_topup` |
| `reject-withdrawal` | `withdrawal_rejected` |
| `agent-deposit` | `agent_collection` |
| `platform-expense-transfer` | `expense_transfer` |
| `process-supporter-roi` | `roi_distributed` |
| `approve-loan-application` | `loan_approved` |

---

## 34. Cost Optimization & Performance

### Event Storm Guard (`src/lib/eventStormGuard.ts`)

- Tracks event frequency per key
- If same event fires > 3 times in 60 seconds → **auto-paused for 5 minutes**
- Console error: `[EventStorm] 🚨 Storm detected`
- 5-second request deduplication window
- Functions: `guardEvent()`, `isDuplicate()`, `releaseDedup()`, `getStormStats()`

### Cost Monitor (`src/lib/costMonitor.ts`)

- In-memory tracking of API requests, DB queries, edge function calls
- Rates per minute calculated from uptime
- Alert thresholds: API > 20/min, DB > 30/min, Edge > 5/min
- Accessible via: `window.__costMetrics()`, `window.__costAlerts()`

### Cron Job Optimization

| Job | Schedule | Optimization |
|-----|----------|-------------|
| `check-agent-liquidity` | Once daily | Reduced from frequent to daily |
| `compute_daily_stats` | Once daily | Reduced from frequent to daily |
| `retry-no-smartphone-charges` | Every 8 hours | Reduced from frequent |
| `batch-process-financials` | With idempotency | 4-minute re-run guard |
| `batch-recalculate-credit-limits` | With empty guard | Skip if no data |

### Polling Optimization

- `PendingPortfolioTopUps` — Manual refresh only (no refetchInterval)
- `UserWithdrawalRequests` — Manual refresh only (no refetchInterval)
- Service Worker update check — Every 5 minutes (was 30s)
- iOS cache invalidation — Every 5 minutes (was 60s)

### Query Cache TTLs (`src/lib/queryCache.ts`)

| Category | TTL |
|----------|-----|
| Dashboard Metrics | 10 minutes |
| Wallet Balance | 2 minutes |
| User Profile | 10 minutes |
| Investment Data | 5 minutes |
| Ledger Data | 3 minutes |

### Verbose Logging

- Production edge functions have verbose `console.log` stripped
- Only financial transactions and errors logged
- Batch logging preferred over per-event logging

---

## 35. Security Architecture

### RLS (Row-Level Security)

- System-only tables (ledger, earnings, repayments) deny client-side writes
- Operations restricted to service-role Edge Functions or managers
- OTP verifications have explicit deny-all for authenticated users
- Materialized views have SELECT revoked from public/anon

### Authentication

- Email + password with email verification (no auto-confirm)
- SMS OTP for mobile users
- Rate limiting on activation (5 attempts, 1-hour lockout)
- USSD callback for basic phone users

### Authorization

| Action | Allowed Roles |
|--------|--------------|
| Role assignment | `super_admin`, `manager`, `cto` |
| Account freeze/delete | `super_admin`, `manager`, `cto`, `coo` |
| Deposit approval | `manager`, `coo` |
| Withdrawal approval | Financial Ops single-step (TID/receipt/bank ref required) |
| Proxy investment | `agent`, `coo` |

### Financial Safety

- Optimistic locking on wallet updates
- 60-second cooldown on rapid-fire investments
- Cascading rollback on partial failures
- Pre-payout liquidity gate (15% reserve)
- Negative balance prevention
- Double-funding prevention via timestamps

---

## 36. Approval & Governance Flows

### Rent Facilitation

```
Tenant/Agent submits → Agent verification (GPS, meters) → Manager approve/reject → Landlord verification → Pool deployment → Obligation created → Auto-charge starts
```

### Supporter Onboarding

```
Agent creates invite (temp password) → Partner activates → Portfolios linked → Pending ops linked → Awaits approval → Wallet credit
```

### Withdrawal Processing

```
Requested (wallet pre-deducted) → Financial Ops Approve & Complete (TID/Receipt/Bank Ref) → Done
Rejected → Idempotent refund via withdrawal_reversal ledger entry
```

### Monthly ROI Payout

```
COO initiates payout → Queued as pending_wallet_operation → CFO approves → Ledger entries → Wallet sync → next_roi_date +1 month → Notification
```

> **Note:** `next_roi_date` advances only upon CFO approval. If a partner is multiple months overdue, each month must be approved sequentially — the partner reappears as OVERDUE after each approval until all arrears are cleared.

### ROI Compounding

```
COO/Partner Ops clicks Compound → Preview dialog (current principal, ROI, new principal) → Confirm → Principal updated (no date change) → Ledger entries (roi_expense + roi_reinvestment) → Audit log
```

> Compounding does NOT create a `pending_wallet_operation` and does NOT advance `next_roi_date`. The partner remains in the Nearing Payouts queue.

---

## 37. SMS & Notification System

### Africa's Talking Integration

| Event | Recipient | Content |
|-------|-----------|---------|
| Rent Approved | Tenant | Amount, daily repayment, start date, reference |
| Rent Approved | Agent | Tenant name, amount, bonus earned |
| Rent Rejected | Tenant | Amount, instruction to contact agent |
| Collection Receipt | Tenant + Agent | Amount collected, remaining balance |

### In-App Notifications

- `NotificationBell` with badge count
- `NotificationsModal` with read/unread states
- Role-specific notification feeds
- Push notification via `send-push-notification` edge function

### Phone Formatting

- Ugandan numbers auto-formatted to +256
- Non-Ugandan numbers skipped
- Supports sandbox and production environments

---

## 38. AI Features

### AI Chat (`welile-ai-chat`)

- Powered by Lovable AI supported models (no API key required)
- Chat history stored in `ai_chat_messages` table
- Page: `/chat`

### AI Dashboard Tools

| Component | Description |
|-----------|-------------|
| `AIBrainDashboard` | AI-powered platform insights |
| `AIRecommendationCard` | AI-suggested actions |
| `AISessionHistory` | Interaction log |
| `AIUserExperienceReport` | UX analysis report |

### AI Receipt Scanning

- `scan-receipt` edge function for OCR processing

### AI Digital Identity

- `src/components/ai-id/` — Digital identity card generation
- `src/lib/welileAiId.ts` — ID utilities

---

## 39. PWA & Offline Support

### Progressive Web App

- `vite-plugin-pwa` with `manifest.json` + `manifest.webmanifest`
- `sw.js` service worker with offline fallback (`offline.html`)
- `manager-manifest.json` for manager-specific PWA
- iOS install guide (`IOSInstallGuide`, `AdaptiveInstallGuide`)
- iOS optimizations (`IOSOptimizations`, `IOSLinkHandler`, `IOSShareReceiver`)

### Offline Data

| Module | Description |
|--------|-------------|
| `offlineDataStorage.ts` | IndexedDB-based data persistence |
| `offlineStorage.ts` | General offline storage |
| `sessionCache.ts` | Session-level caching (`getPreloadedRoles()`) |
| `syncEngine.ts` | Data synchronization engine |

### Offline Dashboard Behavior

1. Roles checked from session cache for instant display
2. If online fetch fails → IndexedDB cached roles used
3. Roles cached to IndexedDB on successful fetch
4. Offline fallback UI only when no cached data exists

---

## 40. Marketplace

### Components

| Feature | Description |
|---------|-------------|
| Product Listings | `products` table with categories |
| Shopping Cart | `cart_items` table |
| Purchases | `product-purchase` edge function |
| Vendor Portal | `/vendor-portal` — Vendor management |
| Seller Profile | `/seller-profile` — Public seller page |
| Flash Sales | `/flash-sales` — Time-limited offers |
| Marketplace | `/marketplace` — Browse/buy products |
| Categories | `/categories` — Product categories |
| Order History | `/order-history` — Purchase history |
| Wishlist | `/wishlist` + `/my-watchlist` — Saved items |
| Shop Entry | `/shop-entry` — Marketplace entry point |

---

## 41. Referral & Ambassador System

### User Referrals

- Monthly referral rewards via `process_monthly_referral_rewards` database function
- `ShareAppButton`, `ShareReferralLink` components
- `ReferralLeaderboard`, `ReferralStatsCard`
- Tracking via `referred_by` profile field

### Landlord Ambassador Program

| Metric | Description |
|--------|-------------|
| Status | `pending` → `active` → `earning` |
| Commission | Based on rent processed through referred landlord |
| Tracking | `rent_processed` and `commission_earned` |

---

## 42. Revenue Recognition Model

Welile uses **proportional revenue recognition** — revenue recognized incrementally as collections occur, NOT upfront.

### Formula

```
revenuePortion = (accessFee + requestFee) / totalRepayment
revenueToday = amountCollected × revenuePortion
principalReturned = amountCollected × (1 − revenuePortion)
```

---

## 43. Risk, Buffer & Solvency Rules

### Coverage Ratio

```
coverageRatio = poolBalance / totalActiveObligations
```

| Threshold | Status | Action |
|-----------|--------|--------|
| > 1.2x | ✅ Healthy | Normal operations |
| 1.0x – 1.2x | ⚠️ Warning | Alert managers |
| < 1.0x | 🔴 Critical | Block new deployments |

### Reserve Requirement

**15% of active capital** locked for monthly supporter rewards. Excluded from deployable pool.

### Solvency Principles

- Solvency > growth
- Low coverage → system flags + alerts, never continues silently
- Cash-out > cash-in flagged as timing gap, not insolvency
- Negative balances prevented at wallet level

---

## 44. Key Platform KPIs

| KPI | Definition |
|-----|-----------|
| **Rent Secured** (North Star) | Total UGX facilitated per month |
| Active Virtual Houses | Currently funded rent deals |
| Rent Success Rate | % of facilitations fully repaid |
| Payment Health | Green/Yellow/Red distribution |
| Capital Utilization | Deployed / Total Pool |
| Liquidity Buffer | 15% reserve available |
| Default Rate | % in default |
| Total Funded | Sum of deployment ledger entries |
| AVG. Deal | total_funded / active_deals |
| Total Rent Due | Outstanding balances |
| Platform Revenue | Proportionally recognized fees |
| Agent Collections | Count and volume of field collections |

---

## 45. Cash Flow Summary by Role

### Tenant
```
IN:  Deposits (MoMo, Agent cash)
OUT: Daily auto-deductions (rent repayment)
OUT: 10% to Welile Homes (automatic savings)
```

### Agent
```
IN:  Sub-agent registration bonus (UGX 10,000 per sub-agent)
IN:  Verification bonuses (UGX 5,000 each: listing, landlord verification, rent application)
IN:  Tenant replacement bonus (UGX 20,000)
IN:  10% commission on rent repayments:
       - Source Agent: 2% of repayment
       - Tenant Manager: 8% (or 6% if recruiter exists)
       - Recruiter Override: 2% (from manager's share)
IN:  2% landlord management fee (non-smartphone landlords)
IN:  2% proxy investment commission
OUT: Cash advances (33% compounding access fee)
OUT: Proxy investments for partners
OUT: Fallback auto-charge deductions
```

### Landlord
```
IN:  Rent payments (direct or guaranteed)
IN:  Guaranteed monthly rent (even if tenant defaults)
OUT: 10% platform fee on guaranteed rent → tenant's Welile Homes
```

### Supporter / Funder
```
IN:  Monthly ROI rewards (15% or 20% compounding)
OUT: Wallet-to-pool investment (instant, no approval)
OUT: Withdrawals (90-day notice, single-step Financial Ops approval)
```

### Platform (Welile)
```
IN:  Access Fees (23/28/33% compounding monthly)
IN:  Request Fees (UGX 10,000 or 20,000)
IN:  Platform Fees on credit (5% compounding)
IN:  10% guaranteed rent program fees
OUT: Agent commissions and bonuses (categorized as marketing_expense in ledger)
     - 10% rent repayment commission (double-entry: cash_out/marketing_expense/platform + cash_in/agent_commission/wallet)
     - Fixed event bonuses: UGX 5K–20K per activity (same double-entry pattern)
OUT: Supporter monthly rewards
OUT: Welile Homes growth rewards (5% monthly)
OUT: Operational expenses
OUT: Withdrawal pre-deductions (withdrawal_pending) and reversals (withdrawal_reversal)
```

---

## 46. Database Schema Overview

### Core Tables

| Table | Purpose |
|-------|---------|
| `profiles` | User profiles (name, phone, avatar) |
| `user_roles` | Role assignments (separate for security) |
| `wallets` | Wallet balances (read-only, trigger-updated) |
| `general_ledger` | Immutable financial transaction log |
| `pending_wallet_operations` | Approval queue |
| `system_events` | Event audit trail (39+ types) |
| `notifications` | In-app notifications |
| `audit_logs` | Administrative audit trail |
| `daily_platform_stats` | Pre-computed daily statistics |

### Rent Facilitation

| Table | Purpose |
|-------|---------|
| `rent_requests` | Rent facilitation requests |
| `landlords` | Landlord registration + GPS + utility meters |
| `credit_request_details` | Full request details |
| `credit_access_limits` | Tenant credit limits + bonuses |
| `disbursement_records` | Disbursement tracking |

### Investment

| Table | Purpose |
|-------|---------|
| `investor_portfolios` | Portfolios (amount, ROI%, status, payout) |
| `supporter_invites` | Invitation management |
| `investment_withdrawal_requests` | Withdrawal requests (90-day notice) |

### Agent Operations

| Table | Purpose |
|-------|---------|
| `agent_collections` | Field collections (GPS, MoMo, method) |
| `agent_visits` | GPS check-in records |
| `agent_earnings` | Commission and bonus tracking |
| `agent_float_limits` | Float limits + daily caps |
| `agent_advances` | Capital advances with interest |
| `agent_advance_ledger` | Daily deduction records |
| `agent_subagents` | Sub-agent hierarchy |
| `agent_goals` | Monthly performance targets |
| `agent_landlord_payouts` | Landlord payment records |
| `agent_float_withdrawals` | Float withdrawal records |
| `agent_delivery_confirmations` | Delivery confirmations |
| `agent_escalations` | Escalation records |
| `agent_tasks` | Task assignments |
| `agent_receipts` | Receipt records |
| `agent_commission_payouts` | Commission cashout records |
| `agent_incentive_bonuses` | Bonus records |
| `agent_collection_streaks` | Gamified streaks |
| `agent_rebalance_records` | Float rebalancing |
| `agent_landlord_float` | Landlord float balances |
| `agent_float_funding` | Float funding records |
| `agent_landlord_assignments` | Landlord assignments |

### Accounting

| Table | Purpose |
|-------|---------|
| `ledger_accounts` | Chart of accounts |
| `ledger_account_groups` | Account groupings |
| `deposit_requests` | Deposit approval queue |
| `earning_baselines` | Performance baselines |
| `earning_predictions` | AI predictions |

### Communication

| Table | Purpose |
|-------|---------|
| `conversations` | Chat conversations |
| `conversation_participants` | Participants |
| `ai_chat_messages` | AI chatbot history |

### Marketplace

| Table | Purpose |
|-------|---------|
| `products` | Product listings |
| `cart_items` | Shopping cart |

---

## 47. Utility Libraries

| Module | Purpose |
|--------|---------|
| `costMonitor.ts` | In-memory cost/request tracking |
| `eventStormGuard.ts` | Event storm detection + request dedup |
| `queryCache.ts` | TanStack Query cache TTL configuration |
| `rentCalculations.ts` | Rent fee/repayment math |
| `creditFeeCalculations.ts` | Credit fee calculations |
| `agentAdvanceCalculations.ts` | Agent advance math |
| `portfolioDates.ts` | Portfolio payout date logic |
| `walletUtils.ts` | Wallet formatting utilities |
| `phoneUtils.ts` | Phone number formatting (+256) |
| `haptics.ts` | Haptic feedback (tap, success) |
| `offlineDataStorage.ts` | IndexedDB persistence |
| `sessionCache.ts` | Session-level caching |
| `syncEngine.ts` | Data synchronization |
| `pendingCountsCache.ts` | Pending counts centralized cache |
| `exportUtils.ts` | CSV/data export |
| `imageOptimizer.ts` | Image optimization |
| `platformDetection.ts` | iOS/Android detection |
| `storageUtils.ts` | Storage helpers |
| `supabaseBatchUtils.ts` | Batch Supabase operations |
| `extractEdgeFunctionError.ts` | Edge function error parsing |
| `opportunitySeenStorage.ts` | Opportunity seen tracking |
| `paymentMethods.ts` | Payment method constants |
| `scheduleUtils.ts` | Scheduling helpers |
| `ugandaBanks.ts` | Ugandan bank list |
| `disableRealtime.ts` | Realtime kill-switch |
| `authValidation.ts` | Auth validation helpers |
| `getPublicOrigin.ts` | Public URL helper |
| `employeeId.ts` | Employee ID generation |
| `notificationSound.ts` | Notification audio |
| `cssAnimations.ts` | CSS animation utilities |
| **PDF Generators** | |
| `agentReportPdf.ts` | Agent performance reports |
| `dailyPerformanceReport.ts` | Daily performance PDF |
| `fraudReportPDF.ts` | Fraud investigation reports |
| `generateAgentTenantPdf.ts` | Agent-tenant relationship PDF |
| `phantomBalanceReport.ts` | Phantom balance detection |
| `portfolioPdf.ts` | Portfolio statements |
| `receiptPdf.ts` | Receipt generation |
| `repaymentSchedulePdf.ts` | Repayment schedule PDF |
| `shareReceipt.ts` | Shareable receipts |

---

## 48. Governing Principles

> - Dignity before growth
> - Systems over heroics
> - Calm over urgency
> - Trust over shortcuts
> - Outcomes over optics
> - Auditability over convenience

**North Star Metric:** Rent Secured (UGX / month)

---

### Shared UI Components

| Component | Description |
|-----------|-------------|
| `UserAvatar` | User avatar with fallback |
| `WelileLogo` | Brand logo |
| `PullToRefresh` | Mobile pull-to-refresh |
| `OfflineBanner` | Offline status indicator |
| `ConnectionStatus` | Network status |
| `ThemeToggle` + `AnimatedThemeToggle` | Dark/light mode |
| `HighContrastToggle` | Accessibility |
| `LanguageSwitcher` + `LocaleSwitcher` | i18n |
| `CurrencyConverter` + `CurrencySwitcher` | Multi-currency |
| `FloatingActionButton` | Generic FAB |
| `FloatingShareButton` | Share FAB |
| `FloatingToolbar` | Floating toolbar |
| `ScrollToTopButton` | Scroll to top |
| `MobileBottomNav` | Bottom navigation |
| `MobileQuickMenu` | Quick menu |
| `BottomRoleSwitcher` | Role switcher |
| `RoleSwitcher` + `AddRoleDialog` + `ApplyForRoleDialog` | Role management |
| `AppBreadcrumb` | Navigation breadcrumbs |
| `CollapsibleQuickNav` + `QuickNavGrid` | Quick navigation |
| `PageTransition` | Route transition animations |
| `AnimatedCard` + `AnimatedList` | Animation wrappers |
| `MetricCard` | Metric display |
| `StatusIndicator` | Status badges |
| `SwipeableRow` | Swipeable list items |
| `ChunkErrorBoundary` | Code-split error handling |
| `DeferredExtras` | Deferred loading |
| `GlobalSettingsToolbar` | Global settings |
| `ParticleBackground` | Visual effects |
| `Confetti` | Celebration effects |
| `SignupPauseBanner` | Signup pause notice |
| `LocationPermissionGate` | GPS permission |
| `WhatsAppPhoneLink` | WhatsApp deep links |
| `PWAInstallPrompt` | PWA install prompt |
| `IOSOptimizations` | iOS-specific fixes |
| `FoodReceiptPromoCard` | Promo card |
| `LoanLimitPromoCard` | Loan promo |
| `CreditAccessDrawSheet` + `CreditRequestSheet` | Credit access |
| `RewardHistoryBadges` | Reward badges |
| `BalanceSheetView` + `CashFlowView` + `IncomeStatementView` + `FacilitatedVolumeView` | Financial views |
| `RevenueChart` | Revenue visualization |
| `TransactionForm` + `TransactionList` | Transaction UI |

---

### Key Pages Summary

| Page | Route | Description |
|------|-------|-------------|
| Landing | `/` | Public landing page |
| Auth | `/auth` | Login/signup |
| Dashboard | `/dashboard` | Role-based main dashboard |
| Settings | `/settings` | User settings |
| Chat | `/chat` | AI chat |
| Calculator | `/calculator` | Public calculator |
| Find a House | `/find-a-house` | Property browser |
| House Detail | `/house/:id` | Property details |
| Benefits | `/benefits` | Platform benefits |
| Privacy | `/privacy` | Privacy policy |
| Terms | `/terms` | Terms of service |
| Join | `/join` | Join/signup flow |
| Install | `/install` | PWA install guide |
| Share Location | `/share-location` | Location sharing |
| Update Password | `/update-password` | Password update |
| Select Role | `/select-role` | Role selection |
| Manager Access | `/manager-access` | Manager login |
| Manager Login | `/manager-login` | Manager auth |
| Executive Hub | `/executive-hub` | Executive dashboards |
| CEO Dashboard | `/ceo/dashboard` | CEO view |
| COO Dashboard | `/coo/dashboard` | COO view |
| CFO Dashboard | `/cfo/dashboard` | CFO view |
| CTO Dashboard | `/cto/dashboard` | CTO view |
| Investment Portfolio | `/investment-portfolio` | Full portfolio |
| Opportunities | `/opportunities` | Funding opportunities |
| Supporter Earnings | `/supporter-earnings` | Earnings detail |
| Angel Pool | `/angel-pool` | Angel pool |
| Marketplace | `/marketplace` | Product marketplace |
| Vendor Portal | `/vendor-portal` | Vendor management |
| My Loans | `/my-loans` | Loan management |
| My Receipts | `/my-receipts` | Receipt history |
| Welile Homes | `/welile-homes` | Savings program |
| Referrals | `/referrals` | Referral dashboard |
| Deposit History | `/deposit-history` | Deposit records |
| Transaction History | `/transaction-history` | All transactions |
| Financial Statement | `/financial-statement` | Financial reports |
| Audit Log | `/audit-log` | Audit trail |
| User Management | `/user-management` | Admin user management |
| Deposits Management | `/deposits-management` | Deposit approvals |
| Staff Portal | `/staff-portal` | Staff access |
| TV Dashboard | `/tv-dashboard` | TV display |

---

*This document is the authoritative complete reference for the Welile platform. All UI components, business logic, edge functions, event architecture, cost optimizations, and governance flows are documented here. Version 3.4 — Last updated: April 13, 2026.*

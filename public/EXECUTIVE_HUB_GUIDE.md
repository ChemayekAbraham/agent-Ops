# Executive Hub — Complete Dashboard Guide

The Executive Hub is the command centre for Welile's leadership team. It consolidates real-time platform data into eight specialised dashboards, each tailored to a specific executive function. Access it via `/executive-hub?tab=<tab-key>`.

---

## 1. CEO Dashboard (`?tab=ceo`)

**Purpose:** High-level business health snapshot for the Chief Executive Officer. Answers "How is the platform performing overall?"

### KPI Cards (8 metrics)
| Metric | Source | What it means |
|---|---|---|
| **Total Users** | `profiles` count | Every registered user on the platform (tenants, agents, landlords, supporters). |
| **Tenants Funded** | `rent_requests` where status is `funded`, `disbursed`, `repaying`, or `fully_repaid` | Number of tenants who have successfully received rent financing. |
| **Rent Financed** | Sum of `rent_amount` across all `rent_requests` | Total UGX value of rent capital deployed to tenants. |
| **Total Landlords** | `landlords` count | Registered property owners on the platform. |
| **Partners/Investors** | `investor_portfolios` count | Number of supporter investment portfolios created. |
| **Platform Revenue** | `general_ledger` entries where `category = 'platform_fee'` and `direction = 'credit'` | Cumulative revenue earned by Welile from service fees. |
| **Rent Repaid** | Sum of `amount_repaid` across all `rent_requests` | Total UGX repaid by tenants — measures repayment health. |
| **Active Agents** | Distinct `agent_id` values in `agent_earnings` | Agents who have generated at least one earning record. |

### Growth Metrics Panel
Five real-time indicators sourced from `daily_platform_stats` (pre-computed) or live fallback queries:
- **Active Users** — Profiles updated in the last 30 days.
- **New Users Today** — Registrations since midnight UTC.
- **Retention** — Ratio of 30-day active users to total users, as a percentage.
- **Referrals** — Percentage of users who signed up via a referral link (`referred_by` is not null).
- **Daily Transactions** — Sum of all `general_ledger` amounts for today's date.

### Charts (3 panels, 6-month window)
1. **Tenant Growth** — Area chart showing new `profiles` created per month.
2. **Capital Raised** — Bar chart showing total `rent_amount` requested per month.
3. **Rent Repayment** — Line chart showing total `amount_repaid` per month.

### Data Table
- **Recent Rent Requests** — Sortable table of the latest 1,000 rent requests with date, status (filterable: Pending, Funded, Disbursed, Repaying, Fully Repaid), amount, and repaid columns.

---

## 2. CTO Dashboard (`?tab=cto`)

**Purpose:** Technical infrastructure and system health monitoring for the Chief Technology Officer. Answers "Is the platform running smoothly?"

### KPI Cards (8 metrics)
| Metric | Source | What it means |
|---|---|---|
| **DB Response Time** | Live latency probe (`performance.now()` around a Supabase query) | Actual round-trip time to the database in milliseconds. Refreshes every 60 seconds. |
| **Active Users (7d)** | `profiles` where `last_active_at` ≥ 7 days ago | Users who interacted with the platform in the past week. |
| **Total Users** | `profiles` count | Total registered accounts. |
| **DB Connection** | Derived from latency: <300ms = Healthy, <1000ms = Slow, else = Degraded | Visual health indicator for database connectivity. |
| **System Events** | `notifications` filtered by `type = error/alert/warning` | Count of error-level events in the notification log. |
| **Security Alerts** | `notifications` where type is `security` or title contains "fraud"/"frozen" | Potential fraud or account-freeze incidents. |
| **Total DB Rows** | Sum of row counts across 8 core tables | Database size indicator — helps plan scaling. |
| **Avg Processing Time** | `deposit_requests`: average time between `created_at` and `approved_at`/`rejected_at` | How long deposit requests take to be processed (in hours). |

### Rent Request Pipeline Health
Five-segment breakdown of all `rent_requests`:
- **Total** — All requests.
- **Pending** — Status: `pending` or `submitted`.
- **Active** — Status: `approved`, `funded`, `disbursed`, or `active`.
- **Completed** — Status: `completed` or `repaid`.
- **Failed** — Status: `rejected`, `defaulted`, or `cancelled`.

### Charts (2 panels, 14-day window)
1. **Daily Active Users (14d)** — Bar chart from `last_active_at` grouped by day.
2. **New Signups (14d)** — Line chart from `profiles.created_at` grouped by day.

### Data Tables
1. **Database Table Sizes** — Row counts for `profiles`, `rent_requests`, `landlords`, `referrals`, `general_ledger`, `notifications`, `deposit_requests`, `investor_portfolios`, sorted by size.
2. **System Event Log** — Filterable table (Error, Alert, Warning, Info, Security) showing timestamp, type badge, event title, and message preview.

---

## 3. CMO Dashboard (`?tab=cmo`)

**Purpose:** Marketing performance and user acquisition analytics for the Chief Marketing Officer. Answers "How effective is our growth engine?"

### KPI Cards (4 metrics)
| Metric | Source | What it means |
|---|---|---|
| **Total Users** | `profiles` count | Platform-wide user base size. |
| **Monthly Signups** | Latest month's `profiles` created count | Current month's new registrations, with month-over-month growth trend arrow. |
| **Referral Signups** | `profiles` where `referrer_id` is not null | Users acquired through the referral programme. |
| **Conversion Rate** | Referral signups ÷ total users × 100 | Percentage of users who came via referrals — measures viral growth effectiveness. |

### Charts (2 panels, 6-month window)
1. **Signup Growth** — Area chart of monthly new user registrations.
2. **Referral Performance** — Bar chart overlaying referral-attributed signups per month.

### Data Table
- **Recent Signups** — Latest 50 users showing date, name, phone, and whether they were referred (organic vs referral).

---

## 4. Agent Operations (`?tab=agent-ops`)

**Purpose:** Field agent performance monitoring and earnings analytics. Answers "How are our agents performing in the field?"

### KPI Cards (3 metrics)
| Metric | Source | What it means |
|---|---|---|
| **Active Agents** | Distinct `agent_id` in `agent_earnings` | Number of agents who have earned at least once. |
| **Total Earnings** | Sum of `amount` from `agent_earnings` | Cumulative UGX earned by all agents across commissions, referrals, and bonuses. |
| **Commissions Paid** | Sum of `amount` from `agent_commission_payouts` | Total UGX paid out to agents via mobile money. |

### Agent Leaderboard
- Horizontal bar chart showing the **top 10 agents** ranked by total earnings.
- Agent names resolved from `profiles.full_name`; falls back to truncated UUID if profile not found.

### Data Table
- **Agent Earnings** — Filterable table (Commission, Referral, Bonus) with date, agent name, earning type badge, and amount. Shows the most recent 200 records.

---

## 5. Tenant Operations (`?tab=tenant-ops`)

**Purpose:** Rent request lifecycle management. Answers "What's the state of our lending pipeline?"

### KPI Cards (6 metrics)
| Metric | Source | What it means |
|---|---|---|
| **Pending Applications** | `rent_requests` where `status = 'pending'` | Requests awaiting review — high counts may indicate processing bottlenecks. |
| **Funded / Disbursed** | Status: `funded` or `disbursed` | Requests where capital has been allocated or sent to the landlord. |
| **Repaying** | Status: `repaying` | Active repayment schedules — tenants making installments. |
| **Fully Repaid** | Status: `fully_repaid` | Successfully completed loans — a measure of portfolio quality. |
| **Defaulted** | Status: `defaulted` | Loans that were not repaid — key risk metric. |
| **Total Requests** | All `rent_requests` | Overall pipeline volume. |

### Data Table
- **Tenant Operations** — Filterable by status (Pending, Funded, Repaying, Fully Repaid, Defaulted). Shows date, colour-coded status badge, rent amount, and amount repaid.

---

## 6. Landlord Operations (`?tab=landlord-ops`)

**Purpose:** Landlord portfolio and rent collection oversight. Answers "How healthy is our landlord network?"

### KPI Cards (6 metrics)
| Metric | Source | What it means |
|---|---|---|
| **Total Landlords** | `landlords` count | All registered property owners. |
| **Verified** | `landlords` where `verified = true` | Landlords whose identity and property have been confirmed by an agent or manager. |
| **Unverified** | Total minus verified | Landlords still awaiting verification — may need agent follow-up. |
| **Total Monthly Rent** | Sum of `monthly_rent` across all landlords | Aggregate monthly rent value in the landlord portfolio. |
| **Rent Balance Due** | Sum of `rent_balance_due` across all landlords | Outstanding rent owed to landlords — a key liability metric. |
| **Properties** | Count of landlord records (each represents a property) | Total properties managed on the platform. |

### Data Table
- **Landlord Operations** — Filterable by verification status. Shows name, phone, property address (truncated), monthly rent, verified status emoji, and balance due.

---

## 7. Partners Operations (`?tab=partners-ops`)

**Purpose:** Supporter/investor capital management and approval workflows. Answers "What's the state of our investment capital?"

### Priority Widget
- **Pending Wallet Operations** — Displays at the top of the dashboard. Shows proxy investments, new portfolios, and withdrawal requests that need immediate manager action.

### KPI Cards (up to 7 metrics)
| Metric | Source | What it means |
|---|---|---|
| **⚠️ Pending Approval** | Portfolios where `status = 'pending_approval'` | High-priority: investment portfolios awaiting manager review. Card pulses amber when count > 0. |
| **Total Partners** | `investor_portfolios` count | All supporter portfolio records. |
| **Active Portfolios** | Status: `active` | Currently earning ROI — capital is deployed. |
| **Total Invested** | Sum of `investment_amount` | Aggregate UGX capital committed by supporters. |
| **Total ROI Earned** | Sum of `total_roi_earned` | Cumulative returns paid to supporters. |
| **Avg ROI %** | Average of `roi_percentage` across portfolios | Mean return rate — measures supporter value proposition. |
| **Upcoming Maturity** | Portfolios with `maturity_date` in the future | Portfolios approaching their payout/renewal date. |

### Data Table
- **Partner Portfolios** — Filterable by status (Active, Pending Approval, Pending, Matured, Cancelled). Shows portfolio code, invested amount, ROI %, ROI earned, colour-coded status badge (pending approval pulses amber), and maturity date.

---

## 8. CRM Dashboard (`?tab=crm`)

**Purpose:** Customer communication and support ticket tracking. Answers "How well are we engaging with users?"

### KPI Cards (6 metrics)
| Metric | Source | What it means |
|---|---|---|
| **Total Inquiries** | `notifications` count | All system notifications/messages sent to users. |
| **Unread** | Notifications where `is_read = false` | Messages not yet seen by their recipients — red indicator for urgency. |
| **Unique Users** | Distinct `user_id` in notifications | Number of individual users who have received communications. |
| **Support Tickets** | Notifications where `type = 'support'` or `'inquiry'` | User-initiated help requests. |
| **Warning Alerts** | Notifications where `type = 'warning'` | System-generated warnings (e.g. low balance, overdue payments). |
| **Read Rate** | (Read notifications ÷ total) × 100 | Percentage of messages that users have opened — measures engagement effectiveness. |

### Data Table
- **Customer Inquiries** — Dual-filterable by type (Support, Inquiry, Alert, Info) and status (Read, Unread). Shows date/time, subject, type badge, read status emoji, and message preview (truncated).

---

## Navigation

All dashboards are accessible from the Executive Hub page header. Use the back arrow to return to the main dashboard. Each tab loads its data independently with a 10-minute cache (`staleTime: 600000ms`) to minimise database load while keeping metrics reasonably fresh.

### Route Reference
| Tab Key | Dashboard | Route |
|---|---|---|
| `ceo` | CEO Dashboard | `/executive-hub?tab=ceo` |
| `cto` | CTO Dashboard | `/executive-hub?tab=cto` |
| `cmo` | CMO Dashboard | `/executive-hub?tab=cmo` |
| `agent-ops` | Agent Operations | `/executive-hub?tab=agent-ops` |
| `tenant-ops` | Tenant Operations | `/executive-hub?tab=tenant-ops` |
| `landlord-ops` | Landlord Operations | `/executive-hub?tab=landlord-ops` |
| `partners-ops` | Partners Operations | `/executive-hub?tab=partners-ops` |
| `crm` | CRM Dashboard | `/executive-hub?tab=crm` |

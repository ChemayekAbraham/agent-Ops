# Welile Technologies — System Roles & Responsibilities

> **Version**: 1.0  
> **Last Updated**: 2026-04-09  
> **Classification**: Internal — Administrative Reference  

---

## Table of Contents

1. [Role Architecture Overview](#role-architecture-overview)
2. [Super Admin](#super_admin)
3. [CTO — Chief Technology Officer](#cto)
4. [CEO — Chief Executive Officer](#ceo)
5. [CFO — Chief Financial Officer](#cfo)
6. [COO — Chief Operating Officer](#coo)
7. [CMO — Chief Marketing Officer](#cmo)
8. [CRM — Customer Relations Manager](#crm)
9. [HR — Human Resources](#hr)
10. [Manager](#manager)
11. [Employee](#employee)
12. [Operations](#operations)
13. [Permission System](#permission-system)
14. [Access Matrix](#access-matrix)

---

## Role Architecture Overview

Welile uses a **single-role provisioning model** — each user is assigned one primary role at signup. Administrative roles are **isolated** into dedicated dashboard environments, meaning staff members are redirected away from the general `/dashboard` to their role-specific workspace upon login.

### Key Principles

- **Separation of Concerns**: Each C-suite role has its own isolated dashboard with role-specific views.
- **Bypass Roles**: `super_admin` and `cto` bypass all permission checks — they have universal access to every dashboard and feature.
- **Permission Gating**: Non-bypass roles rely on the `staff_permissions` table for granular dashboard access beyond their own.
- **Audit Trail**: All administrative actions are logged in `audit_logs` with mandatory metadata.
- **Ledger Integrity**: No role can directly edit balances — all financial movements go through the append-only general ledger.

---

## super_admin

**Route**: `/admin/dashboard`  
**Bypass**: ✅ Universal access to all dashboards and features  

### Responsibilities

| Area | Detail |
|------|--------|
| **Dashboard Access Panel** | Can open any executive or operations dashboard in the system |
| **User Management** | Create, edit, enable/disable staff accounts; assign roles; manage staff access passwords |
| **Role & Permission Assignment** | Grant or revoke dashboard permissions for any staff member via `staff_permissions` |
| **Audit Log** | Full read access to all audit trail entries across the platform |
| **System Configuration** | Platform-wide settings and configuration management |
| **Financial Operations** | Access to deposits, withdrawals, ledger, and reconciliation tools |
| **All Executive Dashboards** | Can access CEO, CTO, CFO, COO, CMO, CRM, and HR dashboards |
| **Operations Dashboard** | Full access to tenant ops, landlord ops, agent ops, and partner ops |
| **Staff Password Resets** | Can reset portal passwords back to system default (`WelileManager`) |

### Route Access

- `/admin/dashboard`, `/admin/users`, `/admin/financial-ops`
- `/ceo/dashboard`, `/cto/dashboard`, `/cfo/dashboard`, `/coo/dashboard`
- `/cmo/dashboard`, `/crm/dashboard`, `/hr/dashboard`
- `/operations`, `/executive-hub`, `/roi-trends`
- `/platform-users`, `/users`

---

## CTO

**Route**: `/cto/dashboard`  
**Bypass**: ✅ Universal access to all dashboards and features  

### Dashboard Sections

#### Engineering
| View | Responsibility |
|------|---------------|
| **Overview** | System health, uptime metrics, and engineering KPIs |
| **System Infrastructure** | Monitor servers, database performance, and cloud resource utilization |
| **API Management** | Track API usage, rate limits, endpoint health, and integration status |
| **Security Logs** | Review authentication events, unauthorized access attempts, and security incidents |
| **Developer Tools** | Internal tooling, feature flags, and system diagnostics |
| **System Logs** | Application logs, error tracking, and debugging information |
| **Platform Users** | Full user directory with search, filtering, and management capabilities (`/platform-users`) |

### Additional Responsibilities

| Area | Detail |
|------|--------|
| **User & Role Governance** | Can assign/revoke roles; manage staff accounts alongside super_admin |
| **Staff Password Management** | Can reset portal passwords back to system default |
| **All Dashboard Access** | Inherits bypass — can access every dashboard for debugging and oversight |
| **Security Oversight** | Reviews security events, unauthorized access attempts logged by RoleGuard |
| **Database Oversight** | Monitors ledger integrity, migration history, and schema health |

### Route Access

- All routes (bypass role)

---

## CEO

**Route**: `/ceo/dashboard`  
**Bypass**: ❌ Requires explicit role or permission grant  

### Dashboard Sections

#### Executive
| View | Responsibility |
|------|---------------|
| **Platform Overview** | High-level KPIs: total users, active rentals, revenue, growth trajectory |
| **Revenue & Growth** | Revenue trends, month-over-month growth, collection rates, and projections |
| **Users & Coverage** | Geographic distribution of users, coverage maps, market penetration metrics |
| **Financial Health** | Solvency ratios, buffer account status, platform financial stability indicators |
| **Staff Performance** | Employee productivity metrics, attendance, and performance scoring |
| **Angel Pool** | Investor/supporter capital pool overview, allocation status, and returns |

### Additional Responsibilities

| Area | Detail |
|------|--------|
| **Strategic Oversight** | Reviews all platform metrics for executive decision-making |
| **ROI Trends** | Access to `/roi-trends` for investment return analysis |
| **Executive Hub** | Access to cross-functional operational data via `/executive-hub` |
| **Financial Ops** | ❌ No direct access to financial operations tools |
| **User Management** | ❌ Cannot manage staff accounts or assign roles |

### Route Access

- `/ceo/dashboard`, `/executive-hub`, `/roi-trends`

---

## CFO

**Route**: `/cfo/dashboard`  
**Bypass**: ❌ Requires explicit role or permission grant  

### Dashboard Sections

#### Finance
| View | Responsibility |
|------|---------------|
| **Overview** | Financial KPIs: total collections, disbursements, outstanding balances, revenue |
| **ROI Requests** | Review and process supporter/partner ROI payout requests |
| **Rent Payouts** | Monitor and approve rent disbursements to landlords |
| **Financial Agents** | Agent financial profiles, earnings summaries, and wallet balances |
| **Cash-Out Agents** | Agents requesting cash-out from commission or float |
| **Float Management** | Agent float limits, funding, rebalancing, and utilization tracking |
| **Financial Statements** | Platform-wide income statements, balance sheets, and cash flow reports |
| **Solvency & Buffer** | Buffer account monitoring, coverage ratios, solvency alerts |
| **Reconciliation** | Cross-reference ledger entries with bank statements and mobile money records |
| **General Ledger** | Full append-only ledger view — the financial source of truth |
| **Commission Payouts** | Process and approve agent commission withdrawal requests |
| **Withdrawals** | Review and approve wallet withdrawal requests |
| **Partner Top-ups** | Track and manage supporter/partner capital injections |
| **Wallet Retractions** | Process wallet balance corrections and retractions |
| **Rent Collections** | Monitor rent collection performance and agent collection activity |
| **Agent Rankings** | Performance-based agent ranking (Gold/Silver/Bronze tiers) |
| **Approval Audit** | Audit trail of all financial approvals and rejections |

#### Disbursements
| View | Responsibility |
|------|---------------|
| **Agent Activity** | Real-time agent field activity and transaction logs |
| **Proxy Agents** | Manage proxy/delegate agent relationships and fund allocations |
| **Agent Requisitions** | Process agent requests for float top-ups and operational funds |
| **Payroll & Advances** | Staff payroll processing and agent advance management |
| **Delivery Pipeline** | Track rent delivery status from approval to landlord confirmation |
| **Cash Reconciliation** | Daily cash-in-hand vs. system balance reconciliation |
| **Landlord Payouts** | Landlord payment processing and confirmation tracking |
| **Advanced Ledgers** | Detailed sub-ledger views (per agent, per partner, per property) |
| **Angel Pool** | Supporter capital pool management and allocation |

#### Advances
| View | Responsibility |
|------|---------------|
| **Manage Advances** | Issue, track, and recover agent advances with interest calculations |

### Additional Responsibilities

| Area | Detail |
|------|--------|
| **Financial Operations** | Direct access to `/admin/financial-ops` for deposits and reconciliation |
| **ROI Trends** | Access to `/roi-trends` for investment return analysis |
| **Payroll Approval** | Final approval authority for HR payroll batches |
| **Platform Expense Transfers** | Authorize platform-level expense disbursements |

### Route Access

- `/cfo/dashboard`, `/admin/financial-ops`, `/executive-hub`, `/roi-trends`

---

## COO

**Route**: `/coo/dashboard`  
**Bypass**: ❌ Requires explicit role or permission grant  

### Dashboard Sections

#### Financial Operations
| View | Responsibility |
|------|---------------|
| **Overview** | Operational KPIs: active requests, agent utilization, processing times |
| **Rent Approvals** | Review and approve/reject incoming rent requests |
| **Transactions** | Monitor all platform transactions in real-time |
| **Agent Collections** | Track agent rent collection activity and performance |
| **Wallets** | View and monitor user wallet balances and movements |
| **Agent Activity** | Real-time field agent activity tracking |
| **Payment Analytics** | Collection rate analysis, payment method distribution, trend charts |

#### Governance
| View | Responsibility |
|------|---------------|
| **Reports** | Generate and view operational reports |
| **Alerts** | System alerts for anomalies, thresholds, and escalations |
| **Withdrawal Approvals** | Approve or reject withdrawal requests |
| **Partners** | Partner/supporter directory and portfolio management |
| **Partner Finance** | Partner financial performance and capital tracking |
| **Partner Top-ups** | Manage pending capital injection requests |
| **Staff Performance** | Employee productivity and attendance metrics |

### Additional Responsibilities

| Area | Detail |
|------|--------|
| **Financial Operations** | Direct access to `/admin/financial-ops` |
| **ROI Trends** | Access to investment return analysis |
| **Operational Oversight** | 16-module operational dashboard (per coov1.md) |
| **Partner Administration** | Full CRUD on supporter portfolios, including suspend/delete |

### Route Access

- `/coo/dashboard`, `/admin/financial-ops`, `/executive-hub`, `/roi-trends`
- `/coo/dashboard` detail pages: active-users, active-landlords, active-partners, earning-agents, new-rent-requests, new-partner-requests, pipeline-landlords, rent-coverage, tenant-balances

---

## CMO

**Route**: `/cmo/dashboard`  
**Bypass**: ❌ Requires explicit role or permission grant  

### Dashboard Sections

#### Marketing
| View | Responsibility |
|------|---------------|
| **Overview** | Marketing KPIs: acquisition cost, conversion rates, channel performance |
| **Growth Metrics** | User growth trends, activation rates, retention analysis |
| **Signup Trends** | New user registration patterns by date, channel, and region |
| **Referral Performance** | Referral program effectiveness, top referrers, conversion funnels |
| **Campaign Analytics** | Marketing campaign ROI, engagement metrics, and A/B test results |

### Additional Responsibilities

| Area | Detail |
|------|--------|
| **Growth Strategy** | Data-driven growth analysis for platform expansion |
| **User Acquisition** | Monitor and optimize signup channels and referral programs |
| **Financial Ops** | ❌ No access to financial operations |
| **User Management** | ❌ Cannot manage staff accounts |

### Route Access

- `/cmo/dashboard`, `/executive-hub`

---

## CRM

**Route**: `/crm/dashboard`  
**Bypass**: ❌ Requires explicit role or permission grant  

### Dashboard Sections

#### Customer Relations
| View | Responsibility |
|------|---------------|
| **Overview** | Support KPIs: open tickets, resolution time, satisfaction scores |
| **Customer Profiles** | Searchable user directory with interaction history and status |
| **Support Tickets** | Manage incoming support requests, assign priorities, track resolution |
| **Disputes** | Handle tenant-landlord disputes, agent escalations, and conflict resolution |
| **Communications** | Platform-wide communication logs and messaging tools |

### Additional Responsibilities

| Area | Detail |
|------|--------|
| **Escalation Management** | Receives and resolves agent escalations (`agent_escalations` table) |
| **Customer Satisfaction** | Tracks and reports on user satisfaction metrics |
| **Financial Ops** | ❌ No access to financial operations |
| **User Management** | ❌ Cannot manage staff accounts |

### Route Access

- `/crm/dashboard`, `/executive-hub`

---

## HR

**Route**: `/hr/dashboard`  
**Bypass**: ❌ Requires explicit role or permission grant  

### Dashboard Sections

#### Human Resources
| View | Responsibility |
|------|---------------|
| **Overview** | HR KPIs: headcount, turnover rate, leave utilization, payroll status |
| **Employee Directory** | Complete staff profiles with contact info, roles, departments, and history. Detail view at `/hr/profiles/:userId` |
| **Departments** | Organizational structure management, department assignments |
| **System Users** | User account management for internal system access |
| **Leave Management** | Process leave requests: approve/reject via `hr-approve-leave` edge function |
| **Payroll** | Monthly batch payroll processing (Draft → Submitted → Approved → Rejected). Submission via `hr-submit-payroll` edge function. CFO final approval triggers `platform-expense-transfer` |
| **Disciplinary** | Track and resolve conduct records via `hr-issue-disciplinary` edge function |
| **Audit Trail** | HR-specific audit log for all personnel actions |

### Additional Responsibilities

| Area | Detail |
|------|--------|
| **Salary Disbursements** | All payroll outflows recorded in `general_ledger` and `audit_logs` |
| **Employee Onboarding** | Create and manage employee profiles and department assignments |
| **Advance Management** | Process salary advance requests |
| **Financial Ops** | ❌ No direct access to financial operations |
| **User Management** | ❌ Cannot assign platform roles (only manages HR records) |

### Route Access

- `/hr/dashboard`, `/hr/profiles/:userId`

---

## Manager

**Route**: `/admin/dashboard`  
**Bypass**: ❌ But has broad operational access  

### Dashboard Sections

#### Administration
| View | Responsibility |
|------|---------------|
| **Dashboard Access Panel** | Open executive and operations dashboards based on granted permissions |
| **User Management** | Create, edit, enable/disable staff accounts; manage user roles |
| **Deposits** | Process and record incoming deposits |
| **Financial Ops** | Access to financial operations tools (deposits, withdrawals, reconciliation) |
| **Audit Log** | Review audit trail entries |

### Additional Responsibilities

| Area | Detail |
|------|--------|
| **Staff Account Management** | Can create staff accounts, assign roles, and reset portal passwords |
| **Agent Operations** | Directory search, performance tiering (Gold/Silver/Bronze), tenant reassignment |
| **Operations Dashboard** | Access to `/operations` for field operations management |
| **Platform Users** | Access to `/platform-users` for full user directory |
| **ROI Trends** | Access to `/roi-trends` for investment analysis |
| **Mandatory Audit Reason** | All administrative actions require a 10-character minimum reason |
| **Soft Delete** | Uses `enabled` flag for user deactivation (not hard delete) |

### Route Access

- `/admin/dashboard`, `/admin/users`, `/admin/financial-ops`
- `/operations`, `/platform-users`, `/executive-hub`, `/roi-trends`

---

## Employee

**Route**: `/admin/dashboard`  
**Bypass**: ❌ Limited access  

### Responsibilities

| Area | Detail |
|------|--------|
| **Dashboard Access Panel** | Can view dashboards they have been explicitly granted access to via `staff_permissions` |
| **Executive Hub** | Access to cross-functional operational views based on permissions |
| **Limited Scope** | Cannot manage users, assign roles, or access financial operations by default |

### Route Access

- `/admin/dashboard`, `/executive-hub`

---

## Operations

**Route**: `/operations`  
**Bypass**: ❌ Focused on field operations  

### Responsibilities

| Area | Detail |
|------|--------|
| **Tenant Operations** | Lifecycle tracking of rent requests: pending → approved → disbursed → defaulted |
| **Landlord Operations** | Property management, chain governance, landlord portfolio oversight |
| **Agent Operations** | Agent directory, performance monitoring, collection tracking |
| **Partner Operations** | Supporter capital management, top-ups, ROI payouts, health scoring |
| **ROI Trends** | Investment return analysis and trend reporting |

### Route Access

- `/operations`, `/executive-hub`, `/roi-trends`

---

## Permission System

### How It Works

1. **Bypass Roles** (`super_admin`, `cto`): Skip all permission checks — full access.
2. **Role-Based Access**: C-suite roles (`ceo`, `coo`, `cfo`, `cmo`, `crm`) automatically get access to their own dashboard.
3. **Granular Permissions**: Additional dashboard access is granted via the `staff_permissions` table, managed by super_admin or manager roles.
4. **RoleGuard Component**: Every protected route is wrapped in `<RoleGuard allowedRoles={[...]}>` which checks the user's roles array.

### Permission Keys

| Key | Dashboard |
|-----|-----------|
| `ceo` | CEO Dashboard |
| `cto` | CTO Dashboard |
| `cfo` | CFO Dashboard |
| `coo` | COO Dashboard |
| `cmo` | CMO Dashboard |
| `crm` | CRM Dashboard |
| `financial-ops` | Financial Operations |
| `company-ops` | Company Staff Management |
| `agent-ops` | Agent Operations |
| `tenant-ops` | Tenant Operations |
| `landlord-ops` | Landlord Operations |
| `partner-ops` | Partner Operations |

---

## Access Matrix

| Route | super_admin | cto | ceo | cfo | coo | cmo | crm | hr | manager | employee | operations |
|-------|:-----------:|:---:|:---:|:---:|:---:|:---:|:---:|:--:|:-------:|:--------:|:----------:|
| `/admin/dashboard` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| `/admin/users` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| `/admin/financial-ops` | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| `/ceo/dashboard` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `/cto/dashboard` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `/cfo/dashboard` | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `/coo/dashboard` | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `/cmo/dashboard` | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `/crm/dashboard` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `/hr/dashboard` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| `/operations` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| `/executive-hub` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `/roi-trends` | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| `/platform-users` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |

> **Note**: `super_admin` and `cto` show ✅ for all routes due to bypass logic, regardless of explicit `allowedRoles` arrays.

---

## Security Notes

1. **Unauthorized Access Logging**: Every blocked access attempt is recorded in `audit_logs` with the attempted route, user roles, and timestamp.
2. **Staff Portal Authentication**: Internal staff use `/manager-login` with dedicated `staff_access_passwords` table and bcrypt hashing via `extensions.crypt`.
3. **Breached Password Protection**: Staff passwords are checked against HIBP (Have I Been Pwned) database; known-breached passwords are blocked.
4. **Default Password Policy**: New staff accounts default to `WelileManager` and must be changed on first entry.
5. **Role Assignment Restriction**: Only `super_admin`, `manager`, and `cto` can assign roles to other users.
6. **Soft Delete**: Users are never hard-deleted — the `enabled` flag is toggled to prevent auto-provisioning conflicts.

---

*This document is the authoritative reference for all admin-level roles and their system responsibilities. It must be updated alongside any feature changes that affect role access or permissions.*

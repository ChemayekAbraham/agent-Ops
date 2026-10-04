# CEO Dashboard — Workflow & Feature Guide

> **Last Updated:** March 2026  
> **Access:** CEO, Super Admin, Manager roles  
> **Route:** `/ceo/dashboard`

---

## Overview

The CEO Dashboard is the strategic command center for Welile Technologies Limited. It provides a real-time, high-level view of platform health, growth trajectory, financial performance, and staff accountability — all from a single screen.

---

## Access & Navigation

| Method | Path |
|--------|------|
| Direct URL | `/ceo/dashboard` |
| Admin Hub | Admin Dashboard → CEO card |
| Manager Menu | Mobile Manager Menu → CEO |
| Executive Hub | `/executive-hub?tab=ceo` |

**Allowed Roles:** `ceo`, `super_admin`, `manager`

---

## Sidebar Sections

The CEO dashboard uses a unified sidebar layout with the following tabs:

### Executive Section
| Tab | Description |
|-----|-------------|
| **Platform Overview** | 8-KPI grid + charts + recent rent requests |
| **Revenue & Growth** | Revenue trends, capital raised, repayment tracking |
| **Users & Coverage** | User base metrics, geographic coverage |
| **Financial Health** | Solvency indicators, buffer status |
| **Staff Performance** | Audit logs, idle alerts, SLA compliance |

---

## Platform Overview (Default View)

### KPI Grid (8 Cards)

The overview displays 8 key performance indicators in a responsive grid:

| KPI | Source | Description |
|-----|--------|-------------|
| **Total Users** | `profiles` table (count) | All registered users across all roles |
| **Tenants Funded** | `rent_requests` (funded/disbursed/repaying/fully_repaid) | Number of tenants who received rent support |
| **Rent Financed** | `rent_requests.rent_amount` (sum) | Total UGX value of rent financed through the platform |
| **Total Landlords** | `landlords` table (count) | Registered landlord accounts |
| **Partners/Investors** | `investor_portfolios` (count) | Active supporter/investor portfolios |
| **Platform Revenue** | `general_ledger` (platform_fee credits) | Cumulative platform fee revenue |
| **Rent Repaid** | `rent_requests.amount_repaid` (sum) | Total rent successfully repaid by tenants |
| **Active Agents** | `agent_earnings` (distinct agents) | Agents who have earned commissions |

All KPIs use a **10-minute stale time** (`staleTime: 600000ms`) to minimize database load.

### Growth Metrics Panel

Below the KPI grid, a secondary metrics row shows real-time growth indicators:

| Metric | Description |
|--------|-------------|
| **Active Users** | Users active in the last 30 days |
| **New Users Today** | Signups since midnight |
| **Retention** | 30-day active users / total users (%) |
| **Referrals** | % of users who joined via referral |
| **Daily Transactions** | Total transaction volume (UGX) for the current day |

**Performance Optimization:** The system first checks the `daily_platform_stats` pre-computed table. If today's snapshot exists, it serves instantly. Otherwise, it falls back to live queries with `get_approximate_user_count` RPC for scale safety.

### Charts (3-Panel)

| Chart | Type | Data |
|-------|------|------|
| **Tenant Growth** | Area Chart | Monthly new tenant registrations (6-month window) |
| **Capital Raised** | Bar Chart | Monthly rent amounts financed (6-month window) |
| **Rent Repayment** | Line Chart | Monthly repayment totals (6-month window) |

### Recent Rent Requests Table

A filterable data table showing the latest rent requests with columns:
- **Date** — Request creation date
- **Status** — Current status (Pending, Funded, Disbursed, Repaying, Fully Repaid)
- **Amount (UGX)** — Requested rent amount
- **Repaid (UGX)** — Amount repaid so far

**Filters available:** Status dropdown (Pending, Funded, Disbursed, Repaying, Fully Repaid)

---

## Staff Performance Tab

Accessible via the sidebar "Staff Performance" tab, this panel provides:

- **Audit Log Monitoring** — Track all administrative actions taken by staff
- **Idle Alerts** — Flag staff members who haven't performed actions within SLA windows
- **SLA Compliance** — Measure response times for approval queues, support tickets, and escalations

This ensures operational accountability across the management team.

---

## Data Architecture

### Caching Strategy

| Layer | TTL | Purpose |
|-------|-----|---------|
| React Query `staleTime` | 10 minutes | Prevents redundant API calls |
| `daily_platform_stats` | Pre-computed daily | Instant dashboard load at scale |
| Approximate counts (RPC) | Real-time | Fallback when snapshots unavailable |

### Data Sources

| Table | Used For |
|-------|----------|
| `profiles` | User counts, retention, referral rates |
| `landlords` | Landlord count |
| `rent_requests` | Funding stats, repayment tracking, recent activity |
| `investor_portfolios` | Partner/investor count |
| `general_ledger` | Revenue (platform_fee), daily transaction volume |
| `agent_earnings` | Active agent count |
| `daily_platform_stats` | Pre-computed growth metrics snapshot |

---

## Design Principles

1. **States over raw data** — KPI cards show counts and percentages, not scrollable lists
2. **Cache-first loading** — Pre-computed snapshots serve the dashboard; live queries are fallback only
3. **10-second rule** — A CEO should identify platform health status within 10 seconds of opening the dashboard
4. **Scale-safe** — All queries are bounded (`limit`), use approximate counts, and avoid full-table scans
5. **No editable data** — The CEO dashboard is read-only; all actions happen in role-specific dashboards

---

## Related Documents

- [Executive Hub Guide](./EXECUTIVE_HUB_GUIDE.md) — All executive dashboards overview
- [COO Roles & Responsibilities](./COO_ROLES_AND_RESPONSIBILITIES.md) — Operations authority
- [Business Logic](./BUSINESS_LOGIC.md) — Core platform rules
- [System Structure](./SYSTEM_STRUCTURE.md) — Technical architecture

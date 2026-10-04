# CTO Dashboard — Workflow & Feature Guide

> **Last Updated:** March 2026  
> **Access:** CTO, Super Admin, Manager roles  
> **Route:** `/cto/dashboard`

---

## Overview

The CTO Dashboard is the technical command center for Welile Technologies Limited. It provides real-time visibility into system health, database performance, user activity patterns, and security events — enabling the technology team to monitor infrastructure reliability and respond to incidents proactively.

---

## Access & Navigation

| Method | Path |
|--------|------|
| Direct URL | `/cto/dashboard` |
| Admin Hub | Admin Dashboard → CTO card |
| Manager Menu | Mobile Manager Menu → CTO |
| Executive Hub | `/executive-hub?tab=cto` |

**Allowed Roles:** `cto`, `super_admin`, `manager`

---

## KPI Grid (8 Cards)

The overview displays 8 key performance indicators in a responsive grid:

| KPI | Source | Description |
|-----|--------|-------------|
| **DB Response Time** | Live latency probe (`performance.now()` around a Supabase query) | Actual round-trip time to the database in milliseconds. Auto-refreshes every 60 seconds. |
| **Active Users (7d)** | `profiles` where `last_active_at` ≥ 7 days ago | Users who interacted with the platform in the past week. |
| **Total Users** | `profiles` table (count) | All registered accounts across all roles. |
| **DB Connection** | Derived from latency: <300ms = Healthy, <1000ms = Slow, else = Degraded | Visual health indicator for database connectivity. |
| **System Events** | `notifications` filtered by `type = error/alert/warning` | Count of error-level events in the notification log. |
| **Security Alerts** | `notifications` where type is `security` or title contains "fraud"/"frozen" | Potential fraud or account-freeze incidents. |
| **Total DB Rows** | Sum of row counts across 8 core tables | Database size indicator — helps plan scaling. |
| **Avg Processing Time** | `deposit_requests`: average time between `created_at` and `approved_at`/`rejected_at` | How long deposit requests take to be processed (in hours). |

All KPIs use a **10-minute stale time** (`staleTime: 600000ms`) to minimize database load.

---

## Rent Request Pipeline Health

A five-segment breakdown of all `rent_requests` providing a quick view of the lending pipeline's technical state:

| Segment | Statuses Included | What It Means |
|---------|-------------------|---------------|
| **Total** | All statuses | Overall pipeline volume. |
| **Pending** | `pending`, `submitted` | Requests awaiting processing — high counts may indicate queue bottlenecks. |
| **Active** | `approved`, `funded`, `disbursed`, `active` | Requests currently in the funding/repayment lifecycle. |
| **Completed** | `completed`, `repaid` | Successfully closed loans. |
| **Failed** | `rejected`, `defaulted`, `cancelled` | Requests that did not complete — monitor for anomalies. |

---

## Charts (2 Panels, 14-Day Window)

| Chart | Type | Data |
|-------|------|------|
| **Daily Active Users (14d)** | Bar Chart | Users grouped by `last_active_at` per day over the past 14 days. |
| **New Signups (14d)** | Line Chart | New `profiles.created_at` entries grouped by day over the past 14 days. |

The 14-day window provides a short-term operational view, complementing the CEO dashboard's 6-month strategic window.

---

## Data Tables

### Database Table Sizes

Displays row counts for the 8 core platform tables, sorted by size:

| Table | Description |
|-------|-------------|
| `profiles` | User accounts |
| `rent_requests` | Lending pipeline |
| `landlords` | Property owners |
| `referrals` | Referral records |
| `general_ledger` | Financial transactions |
| `notifications` | System messages |
| `deposit_requests` | Deposit processing queue |
| `investor_portfolios` | Supporter investments |

This helps the CTO identify rapidly growing tables and plan indexing or archival strategies.

### System Event Log

A filterable table of system events with the following columns:

- **Timestamp** — When the event occurred
- **Type** — Badge-coded: Error (red), Alert (amber), Warning (yellow), Info (blue), Security (purple)
- **Title** — Event subject line
- **Message Preview** — Truncated event description

**Filters available:** Error, Alert, Warning, Info, Security

---

## Monitoring & Alerting

### DB Latency Probe

The dashboard runs a lightweight Supabase query every 60 seconds and measures the round-trip time using `performance.now()`. Results are classified:

| Latency | Status | Visual |
|---------|--------|--------|
| < 300ms | Healthy | Green indicator |
| 300–1000ms | Slow | Amber indicator |
| > 1000ms | Degraded | Red indicator |

### Security Event Detection

Security alerts are surfaced by scanning the `notifications` table for:
- Entries where `type = 'security'`
- Entries where `title` contains keywords: "fraud", "frozen", "suspicious"

These are highlighted with a distinct badge and count in the KPI grid.

---

## Data Architecture

### Caching Strategy

| Layer | TTL | Purpose |
|-------|-----|---------|
| React Query `staleTime` | 10 minutes | Prevents redundant API calls |
| DB latency probe | 60 seconds | Real-time infrastructure monitoring |
| Table row counts | 10 minutes | Prevents expensive count queries |

### Data Sources

| Table | Used For |
|-------|----------|
| `profiles` | User counts, active users, signup trends |
| `rent_requests` | Pipeline health segmentation |
| `notifications` | System events, security alerts |
| `deposit_requests` | Processing time calculations |
| `general_ledger` | Transaction volume (row count) |
| `landlords` | Table size monitoring |
| `referrals` | Table size monitoring |
| `investor_portfolios` | Table size monitoring |

---

## Design Principles

1. **Infrastructure-first** — Every metric answers "Is the system healthy?" before "Is the business growing?"
2. **Short-term focus** — 14-day charts for operational patterns, not strategic trends
3. **Proactive alerting** — Latency degradation and security events are surfaced immediately
4. **Scale awareness** — Table sizes and processing times help anticipate scaling needs
5. **Read-only** — The CTO dashboard is observational; all actions happen in role-specific tools

---

## Related Documents

- [Executive Hub Guide](./EXECUTIVE_HUB_GUIDE.md) — All executive dashboards overview
- [CEO Dashboard Workflow](./CEO_DASHBOARD_WORKFLOW.md) — Strategic command center
- [Business Logic](./BUSINESS_LOGIC.md) — Core platform rules
- [System Structure](./SYSTEM_STRUCTURE.md) — Technical architecture

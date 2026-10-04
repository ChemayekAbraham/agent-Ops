# CRM Dashboard — Workflow & Feature Guide

> **Last Updated:** March 2026  
> **Access:** CRM, Super Admin, Manager roles  
> **Route:** `/executive-hub?tab=crm`

---

## Overview

The CRM Dashboard is the customer communication and support triage center for Welile Technologies Limited. It consolidates all system notifications, user inquiries, and support tickets into a single filterable view — enabling the support team to monitor engagement quality, identify unread backlogs, and prioritize urgent communications.

---

## Access & Navigation

| Method | Path |
|--------|------|
| Executive Hub | `/executive-hub?tab=crm` |
| Admin Hub | Admin Dashboard → CRM card |
| Manager Menu | Mobile Manager Menu → CRM |

**Allowed Roles:** `crm`, `super_admin`, `manager`

---

## KPI Grid (6 Cards)

| KPI | Source | Description |
|-----|--------|-------------|
| **Total Inquiries** | `notifications` table (count) | All system notifications and messages sent to users across the platform. |
| **Unread** | `notifications` where `is_read = false` | Messages not yet seen by their recipients. Displays a red urgency indicator when count is high. |
| **Unique Users** | Distinct `user_id` in `notifications` | Number of individual users who have received at least one communication. |
| **Support Tickets** | `notifications` where `type = 'support'` or `'inquiry'` | User-initiated help requests requiring staff response. |
| **Warning Alerts** | `notifications` where `type = 'warning'` | System-generated warnings (e.g., low balance, overdue payments, failed transactions). |
| **Read Rate** | (Read notifications ÷ total notifications) × 100 | Percentage of messages that users have opened — the primary engagement effectiveness metric. |

All KPIs use a **10-minute stale time** (`staleTime: 600000ms`) to minimize database load.

---

## Data Table — Customer Inquiries

A dual-filterable table showing all notification records with the following columns:

| Column | Description |
|--------|-------------|
| **Date/Time** | When the notification was created |
| **Subject** | Notification title/subject line |
| **Type** | Badge-coded: Support (blue), Inquiry (teal), Alert (amber), Info (grey) |
| **Status** | Read (✅) or Unread (❌) emoji indicator |
| **Message Preview** | Truncated first ~80 characters of the notification body |

### Filters

The table supports two independent filter dimensions:

| Filter | Options | Purpose |
|--------|---------|---------|
| **By Type** | Support, Inquiry, Alert, Info | Isolate specific communication categories |
| **By Status** | Read, Unread | Focus on backlog (unread) or audit completed items (read) |

Filters can be combined — e.g., show only "Unread Support" tickets to prioritize the response queue.

---

## Key CRM Metrics Explained

### Read Rate

The read rate is the single most important engagement metric:

| Read Rate | Interpretation | Action |
|-----------|----------------|--------|
| > 80% | Healthy engagement | Maintain current communication cadence |
| 50–80% | Moderate | Review notification relevance and frequency |
| < 50% | Low engagement | Audit notification types — users may be ignoring noise |

### Unread Backlog

A rising unread count signals one of:
- **Support bottleneck** — Staff aren't responding fast enough
- **Notification fatigue** — Too many low-value messages drowning out important ones
- **Inactive users** — Recipients have churned but still receive system messages

### Support vs System Messages

The CRM distinguishes between:
- **User-initiated**: `support` and `inquiry` types — these require a human response
- **System-generated**: `alert`, `warning`, `info` types — automated notifications that inform but don't require reply

This distinction helps the team prioritize human-response tickets over automated alerts.

---

## Notification Types Reference

| Type | Badge Color | Source | Example |
|------|-------------|--------|---------|
| `support` | Blue | User-submitted help request | "I can't access my account" |
| `inquiry` | Teal | User question or feedback | "How do I check my balance?" |
| `alert` | Amber | System-triggered operational alert | "Deposit request requires approval" |
| `warning` | Yellow | System-triggered risk warning | "Low wallet balance detected" |
| `info` | Grey | Informational system message | "Your rent request has been funded" |
| `security` | Purple | Fraud or account-freeze event | "Account frozen due to suspicious activity" |

---

## Data Architecture

### Data Sources

| Table | Used For |
|-------|----------|
| `notifications` | All KPIs, table data, type/status filtering |
| `notifications.is_read` | Read/unread status and read rate calculation |
| `notifications.user_id` | Unique user count |
| `notifications.type` | Category filtering and support ticket identification |

### Caching Strategy

| Layer | TTL | Purpose |
|-------|-----|---------|
| React Query `staleTime` | 10 minutes | Prevents redundant API calls |
| Table data | 10 minutes | Cached notification list |

---

## Design Principles

1. **Triage-first** — Unread count and support tickets are the most prominent metrics for immediate action
2. **Dual filtering** — Type × Status cross-filtering enables precise queue management
3. **Engagement measurement** — Read rate quantifies whether communications are reaching users effectively
4. **Signal vs noise** — Clear distinction between user-initiated tickets and system-generated messages
5. **Read-only** — The CRM dashboard is observational; responses happen through direct user communication channels

---

## Related Documents

- [Executive Hub Guide](./EXECUTIVE_HUB_GUIDE.md) — All executive dashboards overview
- [CEO Dashboard Workflow](./CEO_DASHBOARD_WORKFLOW.md) — Strategic command center
- [CTO Dashboard Workflow](./CTO_DASHBOARD_WORKFLOW.md) — Technical infrastructure
- [CMO Dashboard Workflow](./CMO_DASHBOARD_WORKFLOW.md) — Marketing & growth
- [System Structure](./SYSTEM_STRUCTURE.md) — Technical architecture

# CMO Dashboard — Workflow & Feature Guide

> **Last Updated:** March 2026  
> **Access:** CMO, Super Admin, Manager roles  
> **Route:** `/executive-hub?tab=cmo`

---

## Overview

The CMO Dashboard is the growth and acquisition command center for Welile Technologies Limited. It tracks user registration trends, referral programme effectiveness, and viral growth metrics — enabling the marketing team to measure campaign impact and optimize acquisition channels.

---

## Access & Navigation

| Method | Path |
|--------|------|
| Executive Hub | `/executive-hub?tab=cmo` |
| Admin Hub | Admin Dashboard → CMO card |
| Manager Menu | Mobile Manager Menu → CMO |

**Allowed Roles:** `cmo`, `super_admin`, `manager`

---

## KPI Grid (4 Cards)

| KPI | Source | Description |
|-----|--------|-------------|
| **Total Users** | `profiles` table (count) | Platform-wide user base size — the top-line growth number. |
| **Monthly Signups** | Latest month's `profiles` created count | Current month's new registrations, with a month-over-month growth trend arrow (↑ green / ↓ red). |
| **Referral Signups** | `profiles` where `referrer_id` is not null | Users acquired through the referral programme — measures organic/viral reach. |
| **Conversion Rate** | Referral signups ÷ total users × 100 | Percentage of the user base that arrived via referrals — the core viral growth effectiveness metric. |

All KPIs use a **10-minute stale time** (`staleTime: 600000ms`) to minimize database load.

---

## Charts (2 Panels, 6-Month Window)

| Chart | Type | Data | What It Shows |
|-------|------|------|---------------|
| **Signup Growth** | Area Chart | Monthly new user registrations over 6 months | Overall acquisition velocity and trend direction. |
| **Referral Performance** | Bar Chart | Referral-attributed signups per month over 6 months | How effectively the referral programme drives new users each month. |

The 6-month window aligns with the CEO dashboard's strategic view, enabling cross-functional comparison.

---

## Data Table — Recent Signups

A table showing the latest 50 user registrations with the following columns:

| Column | Description |
|--------|-------------|
| **Date** | Registration date and time |
| **Name** | User's full name from profile |
| **Phone** | Registered phone number |
| **Source** | Badge: "Referral" (if `referrer_id` exists) or "Organic" (direct signup) |

This table provides a real-time feed of who is joining the platform and how they found it.

---

## Key Marketing Metrics Explained

### Month-over-Month Growth

The **Monthly Signups** KPI card calculates growth by comparing the current month's signup count against the previous month:

- **↑ Green arrow**: More signups this month than last — growth is accelerating
- **↓ Red arrow**: Fewer signups — investigate channel performance or seasonality

### Referral Conversion Funnel

The referral conversion rate measures the percentage of the total user base that was acquired via referral links. A rising rate indicates:
- The referral programme is gaining traction
- Existing users are actively sharing the platform
- Organic growth is compounding

### Channel Attribution

Every user profile stores a `referrer_id` field. When populated, that user is attributed to the referral channel. All other users are classified as "Organic" — arriving via direct signups, marketing campaigns, or agent registrations.

---

## Data Architecture

### Data Sources

| Table | Used For |
|-------|----------|
| `profiles` | Total users, monthly signups, referral attribution |
| `profiles.referrer_id` | Referral channel identification |
| `profiles.created_at` | Signup date for trend charts and recent activity |

### Caching Strategy

| Layer | TTL | Purpose |
|-------|-----|---------|
| React Query `staleTime` | 10 minutes | Prevents redundant API calls |
| Chart data | 10 minutes | Cached monthly aggregations |

---

## Design Principles

1. **Channel clarity** — Every user is attributed to either "Referral" or "Organic" with no ambiguity
2. **Trend over snapshot** — Charts emphasize 6-month direction, not single-day spikes
3. **Actionable simplicity** — Four KPIs answer "Are we growing?" and "Is referral working?"
4. **Read-only** — The CMO dashboard is observational; campaign actions happen in external tools

---

## Related Documents

- [Executive Hub Guide](./EXECUTIVE_HUB_GUIDE.md) — All executive dashboards overview
- [CEO Dashboard Workflow](./CEO_DASHBOARD_WORKFLOW.md) — Strategic command center
- [CTO Dashboard Workflow](./CTO_DASHBOARD_WORKFLOW.md) — Technical infrastructure
- [System Structure](./SYSTEM_STRUCTURE.md) — Technical architecture

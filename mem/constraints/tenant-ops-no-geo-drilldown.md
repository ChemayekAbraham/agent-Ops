---
name: Tenant Ops Operations Intelligence (district drill-down)
description: Tenant Operations has three view modes; the geo drill-down is district-first only — never re-add continent/country/region levels
type: constraint
---
Tenant Operations has exactly three view modes in `TenantOpsHub`:
**New** (`TenantOpsDashboardV2`, default) · **Operations Intelligence** (`TenantOpsGeoCommandCenter`) · **Classic** (`TenantOpsDashboard`).

Classic must never be modified, redesigned or replaced.

**Geo hierarchy is District → Agent only.** The original Continent → Country → Region → District chain was rejected on 2026-07-30 and rebuilt district-first on the user's explicit request. Do not reintroduce continent/country/region levels — the platform only stores meaningful Ugandan district data, and manufacturing higher levels was the reason for the original revert.

Data layer: `useTenantOpsAnalytics` → `get_tenant_ops_geo_metrics` (p_level `district` | `agent`, other params always null) and `get_tenant_ops_agent_360`, backed by `v_tenant_ops_tenant_base` / `_property_base` / `_landlord_base`. All figures live; no mock or derived-from-nothing metrics.

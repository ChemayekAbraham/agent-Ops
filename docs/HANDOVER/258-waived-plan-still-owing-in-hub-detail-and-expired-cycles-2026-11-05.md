# 258 — Waived plan still shown as owing in the calling hub and the agent's expired cycles

**Date:** 2026-11-05 · **Status:** migration written, dry-run PASSED (rolled back), **NOT YET RUN**.

## Symptom
After docs 254-257 Landlord Ops still showed Nakitende Jumeirah owing 336,000.

## Cause
- `landlord_hub_detail` (Landlord Ops calling hub, `tenants_and_plans[].outstanding`) computes total_repayment - amount_repaid for any plan not rejected/cancelled/deleted.
- `v_rent_plan_expired_owing` (read only by `agent_expired_cycles`) has no closed-plan test: it listed plan `406ed7bc` as 336,000 outstanding, 68 days overdue, to the agent now handling the tenant.
(doc 256 had already fixed `landlord_tenant_overview` and `landlord_ops_paid_lists`.)

## Fix
`supabase/migrations/20261105150000_waived_plan_not_shown_as_owing_hub_and_expired_cycles.sql`: both patched in place from their live definitions (anchor must match exactly once or the migration aborts); a plan with an audit row `rent_plan_balance_waived%` owes 0. Same marker as docs 255/256. Dry run: function patched, grants kept, view 632 -> 631 rows (only this plan removed).

## Not changed
Not status-based. Six plans closed `completed` with a shortfall on 2026-09-04 (about 2.2M) still show as owing until the CFO decides.

## Also not live yet
The Call Drawer change from doc 256 (`LandlordCallDrawer.tsx` reading the server balance) is committed on `dev/financial-ops` but not pushed, so the live app still does the old browser arithmetic for that one panel.

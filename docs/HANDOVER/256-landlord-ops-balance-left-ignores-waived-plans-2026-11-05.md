# 256 — Landlord Ops still showed a waived plan balance as owed

**Date:** 2026-11-05 · **Status:** APPLIED to production by the CTO 2026-11-05; both functions verified to carry the waiver filter, grants intact. Drawer change is code only (not yet pushed).

## Symptom
After docs 254/255, Nakitende Jumeirah (plan `406ed7bc`, completed, 216,000 of 552,000 repaid, 336,000 waived) still showed as owing on Landlord Ops.

## Cause
Three readers computed balance as total_repayment - amount_repaid for any plan not rejected/cancelled/deleted:
- `landlord_tenant_overview.balance_left` (landlord's tenant list)
- `landlord_ops_paid_lists.balance_left` (landlord-level, paid/completed tabs)
- `useLandlordTenants` (Call Drawer, browser-side arithmetic on `rent_requests`)

## Fix
- `supabase/migrations/20261105090001_landlord_ops_balance_left_ignores_waived_plans.sql`: both RPCs return 0 for plans with an audit row `rent_plan_balance_waived%` (same marker as doc 255). Bodies are the live definitions plus that one condition.
- `LandlordCallDrawer.tsx` now reads `useLandlordTenantOverview` (server-decided balance) instead of recomputing in the browser. `useLandlordTenants.ts` is left in place, now unused by the drawer.

## Deliberately not done
Not status-based. Six other plans closed `completed` with a shortfall on 2026-09-04 (about 2.22M: Namulundo Alice 1,431,582; inyero beatrice 447,170; Nakisitu Teddy 416,381; Malinga Joel 133,000; kabanda Emanuel 91,800 + 40,400) still show as owing. Whether they should is a CFO decision.

## Verify after applying
`landlord_tenant_overview('<Mutonyi mary landlord id>')` returns balance_left 0 for 406ed7bc; paid_lists balance_left for that landlord drops by 336,000.

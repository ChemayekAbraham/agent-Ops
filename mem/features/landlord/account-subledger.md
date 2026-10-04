---
name: Landlord account sub-ledger (payables/receivables)
description: Dedicated landlord_account_ledger table for admin-side annual payables (monthly rent × 12) and receivables (daily rent × 30 × 12) per placed tenant, separate from the financial general_ledger.
type: feature
---

# Landlord Account Sub-ledger

Admin-side accounting view of what Welile owes each landlord and what is
receivable from each rental. Deliberately SEPARATE from `general_ledger`:
it NEVER drives wallet balances or solvency. Do not post these into
`general_ledger` (no "payable" category exists in the allowlist).

## Table `public.landlord_account_ledger`
- `landlord_id` (landlords.id), `rent_request_id`, `tenant_id`
- `entry_type` `'payable' | 'receivable'`
- `monthly_rent`, `daily_rent`, `months` (12), `days_per_month` (30), `amount`
- `placement_status` (snapshot of rent_requests.status)
- UNIQUE `(rent_request_id, entry_type)` → idempotent upsert per placement
- RLS: ops-only SELECT via `is_ops_role(auth.uid())`; service_role ALL

## Formulas
- Payable A/C = `rent_requests.rent_amount` (monthly) × 12
- Receivable A/C = `rent_requests.daily_repayment` × 30 × 12
- "Placed" scope = status IN (`funded`, `repaying`, `active`, `completed`)

## Generation
- RPC `generate_landlord_payables()` (SECURITY DEFINER, ops-gated) bulk
  upserts one `payable` row per placed rent placement. Re-runnable.
- Receivable rows are computed live in the UI; not yet persisted.

## UI
- Surfaced in `UserDrilldownDrawer` → LandlordPane "Landlord account (annual)"
  card. Payable total prefers recorded sub-ledger rows (shows "N recorded"
  badge + ● marker); falls back to live computation when none recorded.
- Opened from FundedTenantsList "Open profile".
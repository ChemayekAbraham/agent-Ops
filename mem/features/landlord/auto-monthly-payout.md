---
name: Landlord auto monthly payout
description: When agent places a tenant, Welile float fronts the monthly rent into the landlord's withdrawable wallet on a chosen day (1-28). Tenant repayment continues via auto-charge-wallets.
type: feature
---

# Landlord Auto Monthly Payout

## Schema (rent_requests)
- `landlord_payout_day` smallint 1-28 (trigger `trg_validate_landlord_payout_day`)
- `landlord_payout_next_run_at` timestamptz
- `landlord_payout_last_run_at` timestamptz
- `landlord_payout_enabled` boolean default true
- Index: `idx_rent_requests_landlord_payout_due`

## Capture
Set by agent in `AgentRentRequestDialog` at tenant placement. `landlord_payout_next_run_at` computed client-side: next occurrence of chosen day at 07:00 UTC.

## Execution
- pg_cron `pay-landlord-rent-daily` (07:00 UTC) → edge fn `pay-landlord-rent`.
- Picks rows where `enabled=true AND next_run_at <= now() AND status IN (approved, disbursed, active)`, batch 500.
- Per row: `create_ledger_transaction` with platform `rent_disbursement` cash_out ↔ wallet `landlord_rent_payment` cash_in, `recipient_type='user'`, `user_id=landlord_id` → routes to landlord `withdrawable_balance`.
- Idempotency key: `landlord_rent:{rent_request_id}:{YYYY-MM}`.
- Advances `next_run_at` by 1 month (day clamped to 28); writes `audit_logs` (reason `auto-landlord-monthly-payout`) + `system_events` `landlord.rent_payout.completed`.
- Trust signals: landlord `rent_received`, tenant `rent_obligation_serviced`.

## Funding model
Welile float fronts. Tenant repayment is decoupled — recovered by the existing `auto-charge-wallets-daily` cron via `subscription_charges`. Landlord receives rent on schedule even if tenant is late (creating receivable on the platform side).

## Failure handling
On ledger failure: `system_events` `landlord.rent_payout.failed`; `next_run_at` is NOT advanced so the cron retries the next day. No partial payouts.

## To disable
`UPDATE rent_requests SET landlord_payout_enabled=false WHERE id=...;`
# Wire remaining rent paths to the Treasury waterfall

## Goal
Ensure every rent collection on a new-scope plan (funded_at >= 2026-09-08 with positive Access/Registration fees) posts its fee components to Platform Treasury, and that every funding path creates the L7 receivable that makes those collections possible.

## What I verified live
- Wired: `tenant-pay-rent` → `record_rent_request_repayment_v2`; `agent_allocate_tenant_payment_internal` → `post_rent_fee_collection` + `post_treasury_fee_cash_transfer`; `fund-agent-landlord-float` → `recognise_funding_treasury`.
- Not wired to fee posting: `auto-charge-wallets`, `agent-deposit`, `approve-wallet-operation` still call the old `record_rent_request_repayment`.
- Not wired to funding recognition: `approve-rent-request`, `fund-tenants`, `disburse-rent-to-landlord` do not call `recognise_funding_treasury`.

## Plan

### 1. Wire funding-side recognition
Add a non-fatal, idempotent call to `recognise_funding_treasury(p_rent_request_id)` in each funding path immediately after `funded_at` is set and the rent request is in scope.
- `approve-rent-request`
- `fund-tenants`
- `disburse-rent-to-landlord`
- Any other edge function that transitions a rent request to `funded`/`disbursed` after 8 Sep 2026.

The call must be wrapped so funding never fails if the recognition row already exists or if there are no fees.

### 2. Wire collection-side fee posting
Replace the old `record_rent_request_repayment` call with `record_rent_request_repayment_v2` for rent payments in these edge functions:
- `auto-charge-wallets`
- `agent-deposit` (only for rent-repayment branches, not generic deposits)
- `approve-wallet-operation` (only for rent-repayment branches)

Preserve the existing source_table/source_id values so the instalment allocation remains traceable. Because `record_rent_request_repayment_v2` asserts that funding recognition exists, step 1 must be deployed first.

### 3. Exception safety and monitoring
- Ensure every new fee-posting call is exception-wrapped so a bookkeeping failure never blocks a tenant payment.
- Confirm `rent_fee_collection_exceptions` is populated and readable by CFO/finance roles.
- Add a small read-only CFO metric or log warning for open exceptions so missing funding recognition is visible.

### 4. Scope and safety fences
- Only plans where `is_treasury_waterfall_scope()` is true are affected.
- No pricing, no legacy plans funded before 8 Sep 2026, no wallet/commission math, and no existing ledger rows are changed.
- No new database objects are created; only existing RPC/edge-function calls are re-wired.

### 5. Verification
- Run `npm run guard:all`.
- Run a production build.
- Optionally run a dry-run test on a new plan through one wired funding path and one newly wired collection path.

## Out of scope
- Backfilling funding recognition for plans already funded through unwired paths (would change historical ledger state and needs separate approval).
- Refactoring the residual transaction-boundary gap noted in `record_rent_request_repayment_v2` comments.

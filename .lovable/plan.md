# Fix misleading Tenant Self-Repayments card

The card's numbers are arithmetically correct but two columns mislead: refused deposits
show "Kept in float UGX 0" even though the full deposit lands in the tenant's float wallet,
and "Balance after" silently shows today's outstanding rather than the balance at payment time.
This plan corrects the display so the card tells the truth. No money movement, wallet, or
ledger behavior changes.

## Changes

### 1. Show the real float amount on refused rows

`v_tenant_self_repayments` exposes `surplus_amount`, which is only set when a repayment
settles. For every refused outcome the deposit is still credited to the tenant's float
(verified against live data), so "kept in float" should be `amount_deposited − applied_amount`.

- Recreate `public.v_tenant_self_repayments` (CREATE OR REPLACE VIEW, additive) with a new
  computed column `float_kept`:
  `CASE WHEN outcome = 'settled' THEN COALESCE(surplus_amount,0) ELSE COALESCE(amount_deposited,0) - COALESCE(applied_amount,0) END`
- Update `get_tenant_self_repayments` totals so `total_surplus` sums `float_kept` instead of
  `surplus_amount` — keeps the "Kept in tenant float" KPI honest across all pages.
- Panel (`TenantSelfRepaymentsPanel.tsx`) reads `float_kept` for the "Kept in float" cell,
  mobile card, and CSV "Surplus kept" column (rename CSV header to "Kept in float").
- Verification step before editing the view: confirm for each refusal reason
  (`no_active_plan`, `daily_amount_already_paid`, `insufficient_float`, `nothing_outstanding`)
  that the deposit is float-credited; if any reason does not credit float, scope the fallback
  to the reasons that do.

### 2. Rename the drifting balance column

`outstanding_after` is computed live (`total_repayment − amount_repaid` at read time), so it
is the tenant's current outstanding, not the balance after that payment.

- Rename column header "Balance after" → "Current outstanding" (desktop table, mobile card,
  CSV header).
- Add a short helper tooltip/subtitle on the column: "Live balance on the plan today, not at
  the time of this payment."
- No data change: keep showing the live value.

### 3. Type + hygiene

- Add `float_kept: number | null` to `TenantSelfRepaymentRow` in `useTenantSelfRepayments.ts`.
- Run `npm run guard:all` plus typecheck after edits.

## Technical details

- Files: new migration (view + RPC replacement only, no table/policy changes),
  `src/hooks/useTenantSelfRepayments.ts`, `src/components/reporting/TenantSelfRepaymentsPanel.tsx`.
- The view replacement is additive (new column, existing columns unchanged) so other readers
  of the view are unaffected. RPC change is limited to the `total_surplus` aggregate.
- Verify against the live schema before writing the migration (migrations folder is not
  authoritative).
- Out of scope: changing how refused deposits are handled, commission logic, or any
  wallet/ledger writes.

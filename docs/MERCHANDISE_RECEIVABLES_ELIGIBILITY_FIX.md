# Merchandise Receivables Eligibility Fix (7 Oct 2026)

## Why it was needed
A Company Ids order for ANNET NABUTSALE (30 Sep) was entered with quantity 45,000 at UGX 45,000 each (UGX 2.025B). It was still pending approval with no handover, yet a recovery plan with UGX 3.159B outstanding was created with the order. The receivables view counted every active plan with a positive balance, so Total Receivables showed about UGX 5.33B.

Root causes:
1. Quantity/data-entry error (no purchase cap).
2. Premature receivable creation: plans counted before approval or handover.

## What changed
**Eligibility gate** (`merchandise_plan_recovery_eligible`). A plan is owed or recoverable only if its order is eligible:
- Status is approved, processing, issued or completed.
- Company-issued items: the handler has recorded handover.
- Out-sourced items: the CFO payout has been made.

The gate applies to:
- Daily merchandise and bike recovery
- Phone recovery
- "Pay now"
- Receivables (`v_receivables_lines`) and forecasts

**Quantity cap.** Both storefront purchase RPCs reject quantities above 20.

## What did not change
- Pricing and instalment terms.
- Existing orders, plans, ledger entries and wallets. Annet's order and plan are untouched, only excluded from totals.
- No automatic closing of plans when an order is rejected.

## Results (read-only verification)
- Total Receivables: about UGX 5.33B to UGX 2,162,016,239.
- Excluded: pending approval (23 plans, UGX 3,164,495,676, includes Annet), failed (3), rejected bike leases.
- 55 legitimate plans remain eligible (about UGX 16.7M of merchandise balances).
- No new deductions or ledger entries were created.

## Tests
Annet excluded; status transitions; handover and payout unlock; six rejected bikes excluded; 55 legitimate plans stay eligible; quantity 20 allowed and 21 refused; no ledger or order changes.

## Open items
1. Six rejected bike leases are still marked active. They are ignored by recovery and receivables, but nothing closes them.
2. Old bike deductions await a refund decision: Martin Lukwago UGX 109,451 and Peter Bukoma UGX 103.
3. Annet's order needs a decision: confirm the quantity and cancel it through the normal process.
4. Rejected orders should close their plans automatically (not yet built).

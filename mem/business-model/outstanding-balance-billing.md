---
name: Outstanding Balance Billing Model
description: Arrears-only daily auto-charge for outstanding-flow tenants, deferred by outstanding_grace_days; recurring rent is a separate future rent_request
type: feature
---
**Decision (2026-05-11): Arrears-only first, then rent.**

When an agent registers a tenant via the **Outstanding Balance** flow:

- `rent_requests.registration_type = 'outstanding_balance'`
- `initial_outstanding_balance` = arrears amount (the only thing collected by this rent_request)
- `total_repayment = initial_outstanding_balance` (NOT arrears + monthly rent)
- `daily_repayment = ceil(arrears / duration_days)`
- `outstanding_grace_days` (NEW column) = days remaining on tenant's current rent period

**Auto-charge engine behavior (`approve-rent-request`):**
- For outstanding rent_requests, `next_charge_date = today + outstanding_grace_days` (defaults to today+1 if grace is 0/null).
- `end_date = today + duration_days + grace_days`.
- Daily subscription collects ONLY arrears over `duration_days`. No double-billing with the tenant's existing rent period.

**Recurring monthly rent** is intentionally NOT auto-scheduled here. Once arrears clear, the agent creates a fresh rent_request (regular daily/weekly-monthly flow) for ongoing rent. This keeps the two obligations separate, preserves the locked rent formula, and avoids mixing arrears with revenue recognition.

**Legacy storage:** Pre-migration values were stored as `[DAYS_REMAINING:N]` prefix in `landlord_call_notes`. Migration on 2026-05-11 promoted them to `outstanding_grace_days` and stripped the prefix.

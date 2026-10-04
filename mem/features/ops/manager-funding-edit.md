---
name: Manager rent + landlord funding edit (Tenant Ops)
description: Managers/ops edit both rent_amount and the landlord funding (requisition) amount from the tenant drilldown drawer
type: feature
---

# Manager edits in Tenant Ops (UserDrilldownDrawer → Rent balance card)

Two manager-only (is_ops_role: manager/super_admin/coo/operations) edits on a tenant:

1. **Rent amount** — existing `RentBalanceEditor` "Edit rent" → RPC `ops_record_payment_edit(p_edit_type='rent_amount')`.
   DB trigger `trg_enforce_rent_request_formula` recomputes total_repayment/daily_repayment.

2. **Landlord funding (requisition) amount** — `LandlordFundingEditor` "Edit funding" → RPC
   `ops_edit_landlord_funding(p_rent_request_id, p_new_amount, p_reason)`.
   - Edits the open `agent_landlord_float_allocations` row (allocated_amount + remaining_amount).
   - ONLY allowed while `paid_out_amount = 0` (landlord not yet paid) — otherwise raises.
   - Posts the delta through `create_ledger_transaction` (platform `rent_disbursement` +
     bridge `rent_receivable_created`; directions flip for a decrease). Balanced legs.
   - Records to `landlord_payment_edits` (edit_type `landlord_funding` — added to the CHECK),
     `audit_logs` (`ops.edit_landlord_funding`), and `system_events` (`landlord_funding.edited`).
   - UI shows the editor only when an unpaid allocation exists (allocPaid === 0).

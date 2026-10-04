---
name: Agent penalty on landlord / LC1 verification rejection
description: UGX 2,000 wallet penalty + web push to the registering agent when Landlord Ops rejects a landlord or LC1 chairperson; deters fake registrations. House listing rejection stays at UGX 6,000.
type: feature
---
When Landlord Ops sets a landlord or LC1 chairperson to `rejected` via `set_landlord_verification` / `set_lc1_verification`, the RPC (idempotent per record):

1. Debits **UGX 2,000** from the `registered_by` agent's withdrawable wallet (categories `listing_rejection_penalty` / `listing_rejection_recovery`, idempotency keys `landlord_rejection_charge:<id>` / `lc1_rejection_charge:<id>`).
2. Writes an in-app `notifications` row to the agent explaining the rejection + charge.
3. Returns `{ agent_id, agent_charged, charge_amount }` so the client fires a web push via `send-push-notification` (mirrors the house-listing rejection UX).

`ResidenceVerificationPanel.submit` handles the client-side push. House listing rejection charge stays at **UGX 6,000** (`reject_house_listing`). Both RPCs are `SECURITY DEFINER SET search_path = public` and only executable by ops roles.
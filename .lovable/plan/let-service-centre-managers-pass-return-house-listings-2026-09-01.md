# Let Service Centre managers pass/return house listings

## What is broken

When a Service Centre manager taps "Pass to Landlord Ops" on a house listing, the save fails with:

`HOUSE_VERIFICATION_FORBIDDEN: only operations staff may change verification or bonus-payment fields on a house listing (P0001)`

Confirmed cause (checked against the live database):

- `service_center_review_house_listing` is the correct review path and already checks that the caller is either ops staff or the listing's assigned Service Centre manager.
- The `BEFORE UPDATE` guard trigger `guard_house_listing_verification_columns` on `house_listings` blocks any change to `service_center_status` unless the caller holds an ops/executive role. Its allow list has no Service Centre entry, and running inside a security-definer function does not change who the guard sees.

So the review RPC authorises the manager, then the trigger rejects the very update the RPC just made.

## The fix

Add Service Centre managers to the guard's allow list, narrowly:

- A caller who is an active (non-revoked) manager in `service_center_managers` may change **only** the Service Centre review fields: `service_center_status`, `service_center_comment`, `service_center_reviewed_by`, `service_center_reviewed_at`.
- Verification and bonus fields (`verified`, `verified_by`, `verified_at`, `listed_bonus_paid`, `house_verified_bonus_paid`) stay ops-only — Landlord Ops still owns final verification, exactly as today.
- Everyone else is unaffected; the existing ops/executive allow list is kept as is.

Nothing changes in the review workflow, the queue, the comment requirement, or the bonus logic — only the trigger's allow list.

## Technical detail

One migration replacing `public.guard_house_listing_verification_columns()`:

- Keep the existing `auth.uid() IS NULL` trusted-context bypass and the current staff role list.
- Add `v_sc_manager := EXISTS (SELECT 1 FROM public.service_center_managers m WHERE m.agent_id = v_uid AND m.status = 'active' AND m.revoked_at IS NULL)`.
- Split the forbidden-column check: if `v_sc_manager` is true, only raise when a verification/bonus column changed; otherwise raise on the full existing column set (including `service_center_status`).
- Trigger definition itself is unchanged (function is replaced in place).

## Verification

- Re-run the pass/return action as the Service Centre manager on listing P0001 and confirm it saves and lands in the Landlord Ops queue.
- Confirm a Service Centre manager still cannot flip `verified` or a bonus-paid flag directly.

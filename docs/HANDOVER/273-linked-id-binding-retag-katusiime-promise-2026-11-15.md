# 273. Active ID link ignored at the withdrawal gate: Katusiime Promise (2026-11-15)

**Status: APPLIED TO PRODUCTION 2026-11-15 13:34 UTC (recorded as version `20261115133420`). Committed on `dev/financial-ops`, not pushed.** CTO asked for it.

## What happened
- Katusiime Promise (`1eaa4087-…`) has no National ID of her own. Her other account, PROMISE KATUSIIME (`ffadf3bf-…`), holds CF0001010FQEAA.
- The CTO created the link between the two accounts today at 12:25 UTC as a staff action: request `c554ec95-…`, status `active`, holder consent not collected. That migration is on the cloud branch `origin/ccr-8e7a6edd-g0y089` as `20261125110000_link_promise_katusiime_accounts_by_national_id.sql`.
- Even with the link `active`, `withdrawal_user_id_verified` still returned **false** for her.
- The gate (`withdrawal_user_id_verified__impl`) counts a linked identity only when the requester's `user_identity_bindings` row has `capture_source = 'linked_id_owner'`. Her row (`6f94a83a-…`) was written on 29 Oct as `user_capture`, when she filled in the holder's ID details herself, so the gate ignored the link.
- Daisy Liz Nakiboneka (doc 269) passed because her binding was already `linked_id_owner`.

## Change
Migration `20261125120001_linked_id_binding_katusiime_promise.sql` sets that one binding to `linked_id_owner`. It only runs while link `c554ec95` is still active and the binding still carries CF0001010FQEAA. It writes one `audit_logs` row (`identity_binding_retagged_linked_id_owner`).
- `capture_source` is not protected by `identity_binding_immutable_guard`.
- No ID number, photo or payout number changes, and no money moves.
- The file version sorts after the cloud branch's link migration, so a rebuild applies them in the right order.

Rollback: `supabase/rollbacks/20261125120001_linked_id_binding_katusiime_promise.rollback.sql`.

## Verified after applying
- `withdrawal_user_id_verified('1eaa4087-…')` = **true** (was false).
- `withdrawal_user_id_verified('7610e3ea-…')` for Daisy = true, unchanged.
- One audit row written.

## Open, not fixed
- **Staff-created and staff-confirmed links do not retag the binding.** `national_id_link_staff_confirm` and the staff-create SQL set the link `active` but leave `user_identity_bindings.capture_source` alone. Anyone who typed the holder's ID in themselves (`user_capture`) gets an active link that the gate ignores. The general fix is for the confirm path to retag the binding.
- **The payout numbers are close but not identical.** Requester: MTN 0780290**185**, Airtel 256708416**219**. Holder: MTN 0780290**815**, Airtel 0708416**218**. The staff link assumes they are the same person. Worth a FinOps call.
- **A suspect bank account on the holder.** It is named "john Smith" (Absa 68799192749028) and was auto-verified on 5 Nov even though the ID name is PROMROSE KATUSIIME.
- **Date typo in the link marker.** `STAFF-LINK-20261125` was created on 2026-11-15.

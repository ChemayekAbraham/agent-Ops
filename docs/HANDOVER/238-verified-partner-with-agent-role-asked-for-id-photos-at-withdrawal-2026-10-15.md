# 238 - Verified partner with the agent role asked for ID photos again at withdrawal (Kabahuma Lillian, 2026-10-15)

**Status:** exception applied LIVE 2026-10-15 (id `8d3b78c0-773e-4aa7-b55d-48bff60a28e2`); migration
`20261015150000` written to match, not yet in the repo's applied history. Root cause NOT fixed.

## Finding
Kabahuma Lillian (`5f277e34-a830-4ebb-8680-c0c074b279da`, +256706662454) was "approved and verified"
but the withdrawal screen asked her for her ID photos and selfie again.

- Her 0706662454 row in `payout_destination_verifications` (`f940c7ee...`) is `verified`, but by
  auto-verify ("partner with no agent activity is exempt"), not by staff (`decided_by` empty).
- Profile has no `national_id_photo_path`, `national_id_back_photo_path` or `selfie_photo_path`; her
  `identity-verification` storage folder is empty; `user_identity_bindings` has 0 rows.
- Profile `mobile_money_number` is 0745491622 (no name), not 0706662454.
- `payout_withdrawal_block_reasons` returned `identity_not_submitted`.

## Root cause
Two different "is this a pure partner?" checks disagree:
- Auto-verify and the dialog's `useIsPurePartner` use `user_is_pure_partner` (true for her).
- `payout_withdrawal_block_reasons` exempts only `is_partner_not_agent` (false: she holds the `agent`
  role, plus ceo/coo/manager etc.), then finds no binding, no exception and no photos, and blocks.

She has zero `agent_collections`, so she is not an agent actor.

## Change
Migration `20261015150000_kabahuma_lillian_id_verification_exception.sql` inserts one
`id_verification_exceptions` row (skipped if an active one exists) and an `audit_logs` row.
Verified after the live insert: the function returns `blocked: false, status: verified`.
Revoke by setting `revoked_at` on the exception row.

## Not changed
- `payout_withdrawal_block_reasons` still uses `is_partner_not_agent`. Any partner who also holds the
  agent role and has no photos or binding will hit the same screen. Count them before fixing.
- Not tested through a real withdrawal. If it still blocks her, check `withdrawal_destination_gate`.
- Her other destinations were left alone, including an auto-verified bank row (`7128c461...`, 2026-10-12)
  with account name "NASASIRA FAITTH DAVID" against ID name KABAHUMA LILLIAN (name match 0.00). Financial
  Ops should look at it.
- `granted_by` is empty because the insert ran through the service; the reason text names Josh.

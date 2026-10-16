# 241 - Partner account blocked at withdrawal: duplicate National ID with the owner's agent account (KALULE SHARIF, 2026-10-16)

**Status:** exception applied LIVE 2026-10-16 09:00 UTC (id `23103309-67e9-4622-b274-bdca6de0cd26`), verified in the
database; migration `20261016130000` written to match. Not yet confirmed by a real withdrawal. Root cause NOT fixed.

## Finding
`sharifkc264@gmail.com` (KALULE SHARIF, `3f87c1f3-6564-478d-a08d-43da24614c80`, no phone, UGX 5,000,108 available
after a 2,000,108 ROI credit that morning) could not withdraw.

- This is the PARTNER account of agent Sharifu Kalule. His agent account is `98ee118b-06d1-47a4-aa2b-76bd12170b70`
  (kalulesharif618@gmail.com, +256757229748).
- No agent activity on the partner account: 0 `agent_collections`, 0 `agent_visits`, 0 rent requests as agent. Its
  ledger is partner funding, portfolio top-ups and ROI. One agent advance (750,000, 2026-06-12) was cancelled
  2026-07-21 as "wrong account". On 2026-09-30 UGX 3,000,000 was moved from his agent account into this
  account's float ("agent partnership"), the only agent-like entry.
- At 07:23 UTC he tried to register payout number **0757229748**, already verified on his agent account with the
  same National ID. The ID is typed `CMO305210NU9EC` (letter O) here and `CM0305210NU9EC` (zero) there; the
  duplicate check normalises O/0 as the same ID.
- `payout_destination_verifications` row `f1068cff-e9f8-4f9c-8c12-4b83f9ad5b73` was auto-rejected ("National ID is
  already recorded on another account").

## Root cause
The two withdrawal gates disagree about pure partners:
- `withdrawal_destination_gate` and `enforce_withdrawal_destination_verified` exempt `user_is_pure_partner`.
- `issue-wallet-withdrawal-otp` (the step that sends the code) exempts only `id_verification_exceptions`, so a
  rejected destination stops a pure partner before any code is sent.
- `payout_withdrawal_block_reasons` returned `ok` (partner exempt), so the wallet screen showed no reason.

## Change
Migration `20261016130000_kalule_sharif_partner_id_verification_exception.sql` inserts one
`id_verification_exceptions` row (skipped if an active one exists) and an `audit_logs` row
(`ID_VERIFICATION_EXCEPTION_GRANTED`). Revoke by setting `revoked_at`.

## Not changed
- The rejected destination row stays `rejected`; the exception bypasses it. His withdrawals go to 0757229748, which is
  registered to his agent account (same person, name match 1.00).
- `issue-wallet-withdrawal-otp` still lacks the pure-partner exemption. Any other pure partner whose destination is
  rejected will hit the same refusal. Count them before fixing.
- The O/0 mismatch in the stored National ID on the partner account is not corrected.
- Advance recovery only deducts from the agent account's wallet; the partner wallet is out of its reach. See doc 240.
- `granted_by` is empty because the insert ran through the service; the reason text names Josh.

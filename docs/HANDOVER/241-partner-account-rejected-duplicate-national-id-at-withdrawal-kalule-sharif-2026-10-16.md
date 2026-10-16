# 241 - Partner account blocked at withdrawal: duplicate National ID with the owner's agent account (KALULE SHARIF, 2026-10-16)

**Status:** APPLIED LIVE 2026-10-16 and verified in the database: (1) per-user ID exception (`23103309-67e9-4622-b274-bdca6de0cd26`,
migration `20261016130000`) so the withdrawal could be requested; (2) staff-created National ID link
(`4f4a4521-14a6-4c52-bc26-46d16b47d369`, migration `20261016150000`) so Merchant Agents can claim it. Not yet confirmed by a real
merchant claim. Root causes NOT fixed.

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

## Two gates, two fixes
1. **Request gate (OTP step).** `withdrawal_destination_gate` and `enforce_withdrawal_destination_verified` exempt
   `user_is_pure_partner`, but `issue-wallet-withdrawal-otp` exempts only `id_verification_exceptions`, so a
   rejected destination stopped a pure partner before any code was sent (and `payout_withdrawal_block_reasons`
   returned `ok`, so the wallet screen showed no reason). Fix: per-user exception row, migration `20261016130000`.
   After it, withdrawals of 1,000,000 (09:10) and 3,000,000 (11:00) were created, both to 0757229748.
2. **Merchant claim gate (doc 211).** `claim_withdrawal_verified` calls `withdrawal_payout_number_check`: the number must be
   a verified destination, an identity-lock number or the user's own login phone. Partner status and ID exceptions
   deliberately do NOT bypass it (Carol Atuhaire incident, 2026-10-07). The partner account had none, so merchants saw
   "This payout number is not a registered and verified payout number for the customer" and could not claim.
   `finops_decide_payout_destination` could not verify it either: it auto-rejects a duplicate National ID.
   Fix: link the two accounts (below). `duplicate_national_id_owner` skips pairs with an owner_approved/active link, and the
   link's staff-confirm effects verify the requester's destinations.

## Staff-created link (holder consent skipped)
Migration `20261016150000_link_kalule_sharif_partner_account_to_agent_account_by_national_id.sql` inserts an `active`
`national_id_link_requests` row (requester `3f87c1f3`, holder `98ee118b`, NIN `CMO305210NU9EC`), sets
`profiles.linked_national_id` and `linked_national_id_request_id`, verifies the requester's payout destinations
(1: 0757229748) and writes `national_id_link_confirmed` to `audit_logs`.

**The holder's OTP and in-app approval were NOT collected.** Josh Wanda (CFO) explicitly approved skipping holder
consent on 2026-10-16 after tracing the identity: same National ID (identical under `normalize_national_id_fuzzy`),
names match (1.00), 0757229748 is verified on the agent account, and the 09-30 3,000,000 agent-partnership transfer.
`owner_decision` is left NULL and `decision_reason` says consent was skipped, so the record does not claim consent.
The audit row carries `staff_created: true, holder_consent_collected: false`. Undo with the normal unlink flow
(`request_national_id_unlink` / `decide_national_id_unlink`).

## Verified after applying
- Link `active`; partner profile `linked_national_id = CMO305210NU9EC`; destination `momo:757229748` `verified`.
- `withdrawal_payout_number_check` for `7205a6ea-8b3c-48af-8023-2fca11a558c0` (3,000,000) and
  `41fb1c0e-80db-443b-9234-8e21ddbf74e4` (1,000,000): `trusted`, `matched_via: verified_destination`;
  `withdrawal_merchant_id_gate` true; both still `pending`, unassigned.

## Not changed
- `issue-wallet-withdrawal-otp` still lacks the pure-partner exemption. Another pure partner whose destination is
  rejected will hit the same refusal. Count them before fixing.
- The stored National ID on the partner profile still has the letter O (`CMO305...`). Not corrected; the link ignores it.
- This is a manual identity link. The holder (Sharifu Kalule) was never asked; if he disputes it, unlink.
- No merchant has claimed either withdrawal yet; the claim also checks float, channel permission and priority holds.
- Advance recovery only deducts from the agent account's wallet; the partner wallet is out of its reach. See doc 240.
- `granted_by` on the exception row is empty because the insert ran through the service; the reason text names Josh.

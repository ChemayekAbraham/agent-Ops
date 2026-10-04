---
name: NFC card payment
description: Tap-to-Pay verification flow, compact card payload, server-side hydration, pre-flight balance check
type: feature
---
# NFC Card Payment (Tap to Pay)

## Card payload (compact, canonical)
Physical NFC cards and downloadable JSON contain ONLY 4 fields:
`{ version, issuer, card_id, hmac_signature }`. Full HMAC inputs (`user_id`, `pinless_limit`, `issued_at`) live ONLY in the `nfc_cards` table.

## Verification flow (`verify-nfc-card` edge function)
1. Reject if `card_id` or `hmac_signature` missing.
2. Look up `nfc_cards` by `card_id`; hydrate `user_id`, `pinless_limit`, `issued_at`.
3. Recompute `HMAC(card_id|user_id|pinless_limit|issued_at)`, timing-safe compare.
4. Status checks: `active`, owner match, requester != cardholder.
5. PIN required when `amount > pinless_limit`.
6. Pre-flight balance check via `get_user_available_balance(p_user_id := cardRow.user_id)`. If `amount > available` → HTTP 402 `{ error: 'INSUFFICIENT_BALANCE', available, requested }`.
7. On success, insert `money_requests` row (cardholder approves to actually move money). Returns `recipient_name`, `request_id`, `available`.

## Client (`RequestMoneyDialog` Tap to Pay tab)
- NDEF reader iterates ALL records and accepts `text`, `mime`, `unknown`, JSON-bearing `url` records. Strips BOM/language prefix before `JSON.parse`.
- 30s safety timeout flips to a "No card detected" popup instead of spinning forever.
- Result UI lives in `NfcTransactionResultDialog` (success / insufficient / failed) — authoritative confirmation.

## Money movement
Tap NEVER auto-debits. Always creates a `money_requests` row the cardholder approves — preserving Wallet Sole Writer and Withdrawable Strict Rule.

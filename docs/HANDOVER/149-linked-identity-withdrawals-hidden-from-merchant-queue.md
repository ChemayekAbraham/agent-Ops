# 149 — Linked-identity withdrawals were hidden from every Merchant Agent

**Date:** 2026-09-29 · **Instructed by:** Josh Wanda ("there's a withdrawal of Mukisa Juli 92,000 ... whatever blockage remove it")
**Migration:** `supabase/migrations/20260929090000_linked_identity_passes_merchant_id_gate.sql`
**Status:** LIVE 2026-09-29. It was applied to production through `query_database` and verified straight after.
**Follows:** migration `20260924100000_linked_identities_may_withdraw.sql`, which fixed only half of this.

## Symptom

Withdrawal `221c0cc4-fd3e-4fd5-8d86-91d23bc6943a` is Mukisa juli's (+256707911662): UGX 92,000 to Airtel 0754516633 ("Mukisa sharom"). It sat in `pending` from 2026-09-24 13:51 EAT. No merchant was ever assigned, it had no claim, and it had no rejection.

## What was *not* the problem

- **Money.** Her ledger wallet has exactly 92,000: 118,000 in bonuses minus a 26,000 withdrawal in August. `wallets.balance = 0` only because the pending request holds it.
- **Payout destination.** 0754516633 has been `verified` since 2026-09-25 14:01. Its ownership code was confirmed on 09-24.
- **Freeze, hidden flag, priority holds, merchant channel permissions.** None of these applied. 17 active desks accept Airtel wallet withdrawals.

## Root cause

She holds no National ID of her own. She is linked to a holder's ID. The link (`national_id_link_requests` 2cc7ac51) is `active`: the holder confirmed by OTP and approved on 09-24, and Financial Ops approved on 09-25.

Migration 20260924100000 was written for her case. It lets a linked account complete `user_identity_bindings` using the ID owner's documents (`capture_source = 'linked_id_owner'`), and that is why `submit_withdrawal_request` accepted her request.

It missed the second gate. `withdrawal_merchant_id_gate` → `withdrawal_user_id_verified` decides three things:
- what the merchant queue shows,
- what `claim_withdrawal_verified` lets a merchant claim,
- what `auto_dispatch_withdrawals` dispatches.

That function still required the account's **own** `national_id`, ID photo and selfie. A linked account has none of these, so the request was accepted and then was invisible to every merchant.

## Fix

`withdrawal_user_id_verified` now also returns true when **all three** of these hold:
- the account has a non-revoked `linked_id_owner` binding,
- its link request is still `active`, so revoking consent re-blocks it,
- the ID owner's own binding is still non-revoked.

The linked binding already guarantees the stricter bar from 20260924100000: the owner's documents exist, and the account proved its own payout number with a code. All existing paths are restated unchanged.

## Verified after applying

- Mukisa juli, Twahir Ngobya and Hassan Hussein now return `true`. They were the three linked bindings that returned `false`; Mukisa Enock already passed. The other two had no open withdrawal.
- `withdrawal_merchant_id_gate` for 221c0cc4 returns `true`, so it now shows in the merchant queue and can be claimed.

## Not changed

- `withdrawal_user_id_verified` is not in `critical_function_baselines`, so there is nothing to re-baseline.
- Nothing about the withdrawal row was edited. It stays `pending` for a merchant to claim and pay as normal.

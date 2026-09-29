# 153 — Blocked TWAHA AZIZ LUBEGA and Mariam Nalule (accounts + numbers)

**Date:** 2026-09-29 · **Status:** LIVE. Data-only change through the existing `fraud_block_user_identifiers` RPC. No code or migration.

## Why

Two `mobile_money` wallet withdrawals from TWAHA AZIZ LUBEGA (user `99eda4e4-d9d1-402f-b700-1f3500c37974`, login +256740819980) appeared in the payout queue:

| Created (UTC) | Amount | Outcome | Staff note |
|---|---|---|---|
| 09-29 08:28 | 6,200 | rejected 08:39 by `59d45ad2…` | "your not valid please" |
| 09-29 08:42 | 6,000 | rejected 08:44 by `59d45ad2…` | "twaha your not valid please" |

Both paid out to MTN `256777954907`, registered as "Twaha Lubega". That number is also the login phone of a different, new account: Mariam Nalule (`ced8420d-d8cd-4d2b-8857-dbe000178c4a`, created 09-28 12:34 UTC, no wallet, ledger, deposit, collection or rent activity, roles tenant/agent/landlord/supporter). Twaha's own profile `mobile_money_number` is also 256777954907. Twaha resubmitted three minutes after the first rejection.

Diagnostic trap: `get_withdraw_context` and `withdrawal_requests WHERE user_id = <Mariam>` return nothing for Mariam (withdrawable 0, "No withdrawable balance available"). The queue lists by *requester*, not destination, so the row is only found by searching `mobile_money_number` or the name.

Per the standing rule, a name mismatch between account and MoMo registration is normal and is not itself fraud. The block rests on the owner's instruction (two identities tied to one number, repeated resubmission after rejection), not on a classifier finding.

## What was done

Owner instruction: block both accounts and both numbers from signing in or signing up. Ran, for each user:

```sql
select public.fraud_block_user_identifiers(<user_id>, <reason>, null,
  '{"phones":["0777954907","0740819980"],"mobile_money_numbers":["0777954907","0740819980"]}');
```

Result: Twaha 12 identifiers, Mariam 8. Both profiles `is_frozen = true`. Verified with `is_fraud_identifier_blocked` for phone (both numbers, both formats), mobile_money_number, and both emails: all `true`. Audit rows written (`fraud_account_blocked`, `account_flagged` system event).

Blocked identifiers: user_id, email (`bettykyeyisako@outlook.com`, `256777954907@welile.user`), phone and mobile_money_number (256777954907, 256740819980; normalised to the last 9 digits so every format matches), national_id `CM0005210J7FDJ`, and both full names.

## How it is enforced

- **Sign-up:** `handle_new_user()` refuses any active `fraud_identity_blocks` match.
- **Sign-in:** `useAuth` reads `profiles.is_frozen` after sign-in and signs the user out with the "restricted for fraud review" message. Client-side, not a database gate. `auth.users.banned_until` is **not** set, so a session already open may continue until its next profile check. Both users last signed in 09-29 00:xx UTC.
- **Withdrawals/earnings:** `enforce_no_fraud_withdrawal_request` and `enforce_no_fraud_wallet_earnings` triggers also check the block table.

## Open items

- Twaha's wallet still holds **UGX 6,200** (the refunded rejected withdrawals). Not touched. Needs a Finance decision (hold or return).
- The two `full_name` blocks would stop a genuine different person with the same name from signing up. This is how the existing bot-ring blocks behave too.
- Mariam's account has no activity of its own; whether it is a relative, shared phone or an agent using the number was not established.
- To reverse: set the rows in `fraud_identity_blocks` (`source_user_id` in the two ids) to released (`status`, `released_at`, `released_by`) and unfreeze both profiles.

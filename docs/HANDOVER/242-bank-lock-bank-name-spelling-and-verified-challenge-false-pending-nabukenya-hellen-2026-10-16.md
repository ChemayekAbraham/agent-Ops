# Bank lock refused the same account over bank-name spelling, and the app showed "Pending" for a withdrawal that never existed (2026-10-16)

**Read this when:** a user says a bank withdrawal showed "Payment Pending" but nothing reached Financial Ops or the merchant payout queue, when `withdrawal_payout_account_lock_blocked` appears in `audit_logs` for an account number the user really owns, or before touching `enforce_withdrawal_bank_account_lock`, `payout_destination_key` or `verify-wallet-withdrawal-otp`.

**Status:** migration `20261016170000_bank_lock_tolerates_bank_name_variants.sql` **APPLIED LIVE, verified 2026-10-16** (trigger has the tolerant comparison; Hellen's lock row reads `bank:equitybankugandalimited:1046103202361`). Edge function + app change committed, **not yet deployed**. Hellen's retry not yet seen.

## What happened (Nabukenya Hellen, user `bd266fc7…`, 2026-10-15)

She tried a UGX 500,000 bank withdrawal to Equity 1046103202361 at 15:38 and 15:47 UTC. Both were refused with `withdrawal_payout_account_lock_blocked`. The wallet screen still showed "Payment Pending". No `withdrawal_requests` row, no ledger entry, nothing in `v_merchant_payout_queue`. Money never moved.

## Cause 1 — the lock compares bank-name text

`locked_bank_accounts.account_key` is `'bank:' || <bank name, non-alphanumerics stripped> || ':' || <digits>`. Her lock row (backfill 2026-09-30) says "Equity Bank Uganda" → `bank:equitybankuganda:1046103202361`. The picker now sends "Equity Bank Uganda Limited" → `bank:equitybankugandalimited:…`. Same number, different key, so `enforce_withdrawal_bank_account_lock` raised. Her own history uses three spellings ("EQUITY BANK", "Equity Bank Uganda", "…Limited"), so this affects any locked user. 18 of 378 lock rows carry a Limited/Ltd suffix.

**Fix (migration):** same account when the digits are identical AND the normalised bank names are equal or one is a prefix of the other. The same digits at an unrelated bank is still refused. `account_key` and `payout_destination_key` are unchanged, so no stored key moves. Her lock row is realigned to "Equity Bank Uganda Limited" (guarded, no-op on re-run). Not in `critical_function_baselines`, so no re-baseline.

## Cause 2 — "Pending" for a withdrawal that was rejected

`verify-wallet-withdrawal-otp` marks the OTP challenge `verified` **before** it calls `submit_withdrawal_request`. When the submit is rejected, the challenge stays `verified` with no `resulting_withdrawal_id`. A retry on that challenge hit the idempotent branch and answered `{success: true, code: "already_verified", request_id: null}`. `WithdrawFlow` treated that as success, set `isComplete`, and rendered `ReceiptCard` in its default pending state.

**Fix:**
- Edge function: a verified challenge with no withdrawal re-runs the submit, but only while the challenge is unexpired and only with the correct code again. Expired → "Verification expired. Request a new code." A wrong code on a re-submit returns an error and does not touch the challenge status. `submit_withdrawal_request` is idempotent on `client_request_id`.
- `WithdrawFlow.tsx` (handler only): a success with no `request_id` is treated as a failure.

## Verify after applying

1. `select account_key, bank_name from locked_bank_accounts where user_id='bd266fc7-1066-468a-8beb-347430d9d9b6'` → `bank:equitybankugandalimited:1046103202361`.
2. She retries the 500,000 withdrawal; a `withdrawal_requests` row appears with `payout_method='bank_transfer'`.
3. A request with the same digits at a different bank name (not prefix-related) is still refused.

## Not done

- 17 other locked users have a suffix spelling; the trigger change covers them, no data change was made.
- Where a bank withdrawal sits afterwards (FinOps approval vs merchant agent queue) was not checked because no row existed.

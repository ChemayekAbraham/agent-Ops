# 168 — TID guard missed 11-digit MTN ids: manual float credit then email auto-match credited twice

**LIVE 2026-09-29.** Guard function replaced through `query_database` and verified. Migration file: `20260930000000_tid_guard_covers_11_digit_mtn_reference.sql`.

## Symptom

Josh had manually credited three agents' float (Financial Ops → Manual Float Credit) while the IFTTT forwarder was down. When it came back at 23:01 EAT it delivered a backlog of about 39 SMS emails in two minutes. Two of those emails were the same MTN deposits Josh had already credited by hand. The auto-match credited them again.

| Agent | Manual credit | Auto-match second credit |
|---|---|---|
| Watsala Enock | 16,000 (TID 157665927432, Airtel) | none |
| Tijan Edris | 7,200 (TID 157653450211, Airtel) | none (his 2,800 is a different TID) |
| NATTU SHARIFAH | 50,000 (43865167695) and 30,000 (43868722751), MTN | **both, 20:03 UTC** |

## Root cause

`enforce_tid_deposit_uniqueness()` finds the TID with `extract_tid_normalized()`, which recognises `TID<10-14 digits>` or a standalone **12-13 digit** run. The two Nattu TIDs are **11 digits**. The guard found no TID, returned early, and neither blocked the second credit nor recorded a lock. Airtel TIDs are 12 digits, so they were always protected, which is why Watsala and Tijan were unaffected.

The manual RPC (`finops_manual_float_credit`) locks the TID itself, so the manual-then-auto order left a lock that the auto path never looked at.

## Correction (Nattu only)

Only these two TIDs were credited twice today. A same-day scan of `agent_float_deposit`, `wallet_deposit` and `deposit` credits with a repeated TID found nothing else.

- Two reversals posted through `create_ledger_transaction`, a wallet `cash_out` on float plus a platform offset per TID. Groups `8dcb1216-38ca-4bb7-b8f7-4c90cb5b55db` (30,000) and `b0e734f3-87b0-4e50-83ec-f6cfd6769e0f` (50,000). Idempotency keys `dup_autocredit_reversal:<deposit_request_id>`.
- `source_table='deposit_requests'` with the deposit id, so `tg_credit_tid_backed_float` decremented `agent_tid_backed_float` in the same step.
- Nattu's float went 80,000 → 0 and TID-backed 80,000 → 0. Neither went negative. She had already spent about 87k from float on rent collections, so part of the duplicate was already used; her real float after the reversal is 0.
- The two `deposit_requests` rows got `auto_credit_review_status='reversed'` with notes. Their `status` was left `approved` and the Gmail links were kept, so nothing re-routes them.

## Fix

The guard now falls back to `reference_id` when it is exactly a TID (optional `TID` prefix plus 10-14 digits). `extract_tid_normalized()` is unchanged, because loosening it for free text would match phone numbers and amounts. Verified that the live function contains the fallback and the trigger is enabled. It is not in `critical_function_baselines`.

## Not done / watch

- No test insert was run against production. The fallback is verified by reading the live definition, not by a rejected credit.
- From now on an 11-digit MTN TID is locked on its first credit. This matches how 12-digit Airtel TIDs already behave.
- The deposit that landed on Nattu's account while she was spending float is a business call: whether she owes the ~7k she spent beyond her real deposits is not decided here.

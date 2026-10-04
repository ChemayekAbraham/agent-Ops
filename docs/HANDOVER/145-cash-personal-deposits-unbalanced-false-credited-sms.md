# 145 — Cash personal deposits never credited since 09-24, but the depositor was told "credited"

**Date:** 2026-09-28 · **Reported by:** Josh (an SMS screenshot: "UGX 6,000,000 credited … receipt code 5602 … New balance UGX 638,076")
**Code changed:** `supabase/functions/approve-deposit/index.ts`, `supabase/functions/cash-deposit-verify-code/index.ts`
**Status (2026-09-28 12:35 UTC): second fix DEPLOYED.** Lovable deployed `approve-deposit` and `cash-deposit-verify-code` from HEAD, which contains `27298acfe6`. The deploy is Lovable edit `edt-5e1bb18d`, and both functions answered a preflight request. It has not yet been confirmed by a real deposit: the next cash personal deposit should be approved on the first code entry with 4 ledger legs. Nankambo's 9 stuck deposits (UGX 33.2M), plus a 10M one entered at 11:48, were **re-credited on Josh's instruction**; see "Re-credit".

## What happened

Every physical-cash deposit with purpose `personal_deposit` has failed since commit `f905c1182c` (2026-09-24 15:47 EAT).

That commit corrected the accounting to **DR A5 / CR L1**, posted as two legs:
- a wallet `wallet_deposit` `cash_in`,
- a platform `cash_receipt_in_transit` `cash_in`.

Both sides come from `ledger_account_map`, so the entry is correct double entry. But `create_ledger_transaction` also checks **raw direction totals** (`total cash_in = total cash_out`), and two `cash_in` legs can never pass that check. Every such deposit failed with `Transaction not balanced. Total cash_in (2×amount) <> total cash_out (0)`, and `approve-deposit` marked the request `failed`. The commit's simulation priced groups against the mapping and never ran the RPC's raw check. Float cash deposits keep the four-leg shape and were unaffected: 5 of them, UGX 45M, were approved on 09-25.

### Why the depositor was told "credited"

In the receipt-code path (`cash-deposit-verify-code`):
1. The first code entry fails, the verification is rolled back to `awaiting_code`, and the deposit is now `failed`.
2. The operator enters the code again. `approve-deposit` only selects `pending` rows, finds none, and returns `{success: true, already_processed: true}`.
3. The verify function treated `already_processed` as success. It logged `credited` and sent the SMS "Cash deposit confirmed. UGX X credited…", while the ledger had nothing.

## Fix

1. **`cash-deposit-verify-code`:** after calling `approve-deposit`, it re-reads the deposit. Anything other than `status = 'approved'` is a `credit_failed`, which means no "credited" event and no SMS. The event metadata now carries `deposit_status`.
2. **First `approve-deposit` fix (published, did not work):** it posted the two-leg group through `postBalancedLedgerGroup` with `skip_balance_check`. But `skip_balance_check` only skips the *user-funds* check. The raw `cash_in = cash_out` check in `create_ledger_transaction` is unconditional, so deposits kept failing. At least they now fail honestly, because of item 1. `balancedLedgerPost.ts`'s own comment implies otherwise. Its three callers are raw-balanced anyway, so they are unaffected.
3. **Second `approve-deposit` fix:** physical cash + personal now posts **two groups**, and each already exists in production:
   - **Credit:** the mobile-money personal-deposit shape, a wallet `wallet_deposit` `cash_in` (CR L1) plus a platform `wallet_deposit` `cash_out` (DR A1). The key is `deposit_credit:<id>`.
   - **Reclass A1 to A5:** the same legs and the same key (`cash_receipt_transit:<id>`) as `fin_ops_set_cash_location`'s legacy reclass. Those are `cash_receipt_in_transit` `cash_in` (DR A5) plus `cash_at_bank_reclass` `cash_out` (CR A1).
   - **Net effect:** DR A5 / CR L1, and each group is balanced raw and on the mapping. The bank reconciliation, `assert_money_path_intact` and the later "banked" step all still find `cash_receipt_in_transit`.
   - **If the reclass fails:** the wallet is still credited, and `fin_ops_set_cash_location`'s legacy branch repairs A1 when the cash location is set.
   - **Tested live:** these exact leg shapes posted successfully 18 times through `create_ledger_transaction` in the re-credit below.

## Re-credit (done 2026-09-28 by SQL, on Josh's instruction "credit them on her account")

Josh was shown that UGX 27.2M of the 9 had no matching bank or MoMo receipt, and that the four 6M entries looked like retries. He chose to credit all 9 anyway.
- Each deposit got the two groups above, was set to `approved`, and got an `audit_logs` row `deposit_recredited_doc145` holding both group IDs.
- **Result:** her withdrawable balance went from 638,076 to **33,838,076**. On the mapping the 18 groups net A5 +33.2M, L1 -33.2M, A1 0, and 0 of them are unbalanced.
- **Not touched:** Mercy Bayo's 5M (`114fdd7b`, 09-25) is still `failed`.

## The stuck deposits (as found, before the re-credit)

9 deposit requests, **UGX 37,500,000**, 2 accounts. Every one is `failed`, has no ledger legs, and had a false "credited" event and SMS:

| Created (UTC) | Account | Amount | Cash owner on the request |
|---|---|---|---|
| 09-25 10:30 | 59d45ad2 | 2,000,000 | (account holder) |
| 09-25 11:53 | 6b7d9eee | 5,000,000 | (account holder) |
| 09-28 07:56 | 59d45ad2 | 6,000,000 | account holder |
| 09-28 08:12 | 59d45ad2 | 1,000,000 | a third party |
| 09-28 08:13 | 59d45ad2 | 1,500,000 | a third party |
| 09-28 08:14 | 59d45ad2 | 4,000,000 | a third party |
| 09-28 08:25 | 59d45ad2 | 6,000,000 | account holder |
| 09-28 09:47 | 59d45ad2 | 6,000,000 | account holder |
| 09-28 09:51 | 59d45ad2 | 6,000,000 | account holder (receipt code 5602, the screenshot) |

**Do not bulk re-credit.** The four UGX 6,000,000 requests on 09-28 have the same account and cash owner, and are spread over two hours. That fits one real deposit retried because the balance never moved after a "credited" SMS. Re-crediting all four could over-credit by up to UGX 18M. Financial Ops must confirm which cash was physically received, then:
- reopen only those requests to `pending` (`approve-deposit` `action: 'reopen'`),
- approve them after the deploy,
- and mark the rest `rejected` as duplicates.

Also note: on 59d45ad2 the operator who issued and entered the code (`initiated_by`, `entered_by`) is the depositor's own account.

## Verify after deploy

```sql
-- no new unbalanced failures
select count(*) from deposit_requests
 where rejection_reason ilike 'Ledger credit failed: Transaction not balanced%'
   and created_at > '<deploy time>';
-- a new cash personal deposit posts exactly two legs and is approved
select g.ledger_scope, g.category, g.direction, g.amount
  from general_ledger g where g.source_table = 'deposit_requests' and g.source_id = '<new id>';
-- no credited event without an approved deposit
select e.deposit_request_id from cash_deposit_verification_events e
  join deposit_requests d on d.id = e.deposit_request_id
 where e.event_type = 'credited' and d.status <> 'approved' and e.created_at > '<deploy time>';
```

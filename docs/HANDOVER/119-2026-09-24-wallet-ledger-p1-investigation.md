# 119 — 2026-09-24 P1 wallet/ledger investigation (commission, transfers, payment reconciliation)

**Investigation, read-only against live prod, 2026-09-24.** Covers the P1 brief items: agent
commission revenue recognition (2), wallet send-money end-to-end (4) and digital payment
confirmation/reconciliation (5). Items 3 and the "repaying" precondition are docs 118 and 117.
Nothing in this doc has been fixed yet unless it says so.

## Precondition: is the wallet write path broken?

**No.** The CTO report's "ledger postings collapsing 23,757 → 11,378 → 4,182" and the rollback
spike were the one-off receivables restatement batch (doc 116), already back near baseline. That
was re-checked independently here:

- User transfers on 09-21/22/23 were 4/6/4, which is normal.
- Every `wallet_transfer` group in the last 14 days nets to zero.
- The wallet balance projection equals the ledger for all 93 transfer users.
- There are no negative balances.

The real defects are specific and are listed below. None of them is a general write-path failure.

## Item 4 — wallet send-money: works

Path: `SendMoneyDialog.tsx:523` → `useWallet.ts:169 sendMoney` → edge fn `wallet-transfer` →
`create_ledger_transaction` (SECURITY DEFINER; two legs in one transaction, balanced-group and
no-negative triggers).

- 163 user transfers in 30 days. The last success was 09-24 05:56 UTC.
- There are no one-sided or orphaned transfers.
- There is no fee and no OTP.

Defects (not fixed):
1. **No retry idempotency.** `wallet-transfer/index.ts:355` makes a fresh `WT-` key on every
   request, so a network retry or a second tap sends twice. Only the dialog's `loading` state
   prevents it. One suspicious pair exists: `WT-5DDC8AD0`/`WT-314A6CAF`, UGX 10,000, 161 s apart on 09-18.
2. **Concurrent double-spend window.** The balance check in `create_ledger_transaction` isn't
   serialized per sender, because the advisory lock is on the random key. Fix:
   `pg_advisory_xact_lock(hashtext(sender))` before cash_out checks. Not exploited: there are no
   negative balances.
3. `PendingRequestsDialog.tsx:114` sends by phone. The edge fn matches `phone ilike '%last9' limit 1`
   with no ordering, so it can pay a stale duplicate profile (the known duplicate-identity bug).
4. `PayLandlordDialog.tsx:180`'s "no account" branch sends `recipient_id: null` and always fails 400.
5. Rejected transfers aren't logged anywhere, so the failure rate isn't measurable from the DB.

## Item 5 — payment confirmation & reconciliation

There are **no MoMo provider callbacks** (`momo-webhook` in SYSTEM_CONTEXT doesn't exist). Intake
is IFTTT SMS → Gmail → `gmail-poll-transactions` (every minute) → `gmail_transactions` → TID,
direct-rent, phone, name and fuzzy matching → `deposit_requests` → `approve-deposit`.

### Complaint (a): "payment messages not arriving" — real, four causes
1. **SMS provider credit exhausted.** Yoola returned HTTP 402 `insufficient_fund` from 09-12, and
   **it is still happening today**: 09-24 so far has 121/947 failed, 41 of them insufficient-funds.
   Africa's Talking fallback was also out of balance 09-12 to 09-17. Deposit-SMS failure peaked at
   55% (09-14). *Ops action: top up Yoola.*
2. **Manually approved deposits never send an SMS**, by design, only in-app: 90 deposits,
   UGX 579M, in 30 days.
3. **`record_direct_tenant_rent_payment` does not exist in prod** (verified). Migration
   `20260907130000_direct_tenant_rent_payment.sql` was never applied, but
   `gmail-poll-transactions/index.ts:2699` calls it. Since 09-07, about 114 tenant MoMo rent
   payments (52 payers, ~UGX 33.2M, per the sub-investigation) fell through and were credited
   as Operational Float instead of rent. The tenant gets the wrong message and the plan is not
   reduced. **Needs a decision.** Applying a 17-day-old ledger migration now will re-route live
   money. Review it against later changes first (doc 96 TID-backed float, doc 117 repaying gate),
   then decide how to re-classify the ~114 historical payments.
4. Logging gaps hide the real failure rate. gmail-poll's Africa's Talking fallback isn't logged
   (`index.ts:3157-3191`), and approve-deposit's Yoola sends log without `reference_id`/`recipient_user_id`.

### Complaint (b): "gap between expected and messaged amount"
- **Deposits have no gap.** 1,715 TID-joined deposits, 0 amount mismatches. Auto-approve requires
  exact equality, and a mismatch is not credited at all.
- **The gap is in tenant rent SMS.** `tenant_self_repayment` says "Still due today: UGX 7,000"
  while `tenant_notify:PAYMENT_FULL` says "fully cleared" to the same tenant within a minute
  (6 of 11 "still due" SMS; e.g. Nabutanda, `d267a2fa`, 09-23). There were 1,490 partial
  collections (UGX 22.0M short) in 30 days, and the SMS never states the expected amount.

### Money defects found
- **Confirmed double credit.** TID `43274057893`, UGX 300,000, auto-credited to deposit
  `be819801` (user `1493ed6c…`) on 09-04, then credited again via `cfo-direct-credit` to user
  `3d78f1f8…` on 09-06 (verified in `general_ledger`). Both balances were spent. Root cause:
  `cfo-direct-credit`'s idempotency is keyed on (TID, target user) and never checks whether the TID
  was already credited to someone else. **Needs a FinOps call on recovery plus a code fix.**
- 54 MoMo receipts (UGX 57.0M) in 30 days are unmatched, unrouted and unreconciled; 47 of them
  are >48 h old.
- 3 deposits (`228fc1ec`, `eecb7342`, `80559186`; UGX 860k) are TID-linked with an exact amount
  match but still pending. The 7-day Gmail window in the sweep/auto-approve drops them.
- The retry job linked 2 Gmail rows by amount only (different TIDs) and retried them 1,063 and 868 times.

### Where exceptions sit unseen
- `deposit_match_alerts`: 198 open (UGX 208.7M), emailed but no page reads them, and 30 of them
  are stale-but-open.
- `email_receipt_possible_match` is missing from the live CHECK constraint, so 53 fuzzy flags
  (UGX 32M) failed to insert without any error.
- `sms_failure_alerts`: 30 critical alerts, all open, `email_sent = 0`.
- Bridge DEAD_LETTER: 17 open, UGX 21.5M, since 07-28.

**Proposed surface (not built):** `get_reconciliation_exceptions(p_since)`, a SECURITY DEFINER
function gated to FinOps/CFO roles, returning one row per exception (type, severity, age, UGX,
user, TID, source id, suggested action). Types:
- orphan receipt;
- linked-but-stuck deposit;
- amount/TID mismatch on a link;
- same TID credited more than once, across `deposit_requests` and `cfo_direct_credit` ledger rows;
- cross-user TID collision;
- credited with no successful confirmation SMS;
- contradictory tenant SMS;
- matcher RPC errors;
- open, un-actioned alerts.

Never flag profile-name ≠ MoMo-name.

## Item 2 — agent commission revenue recognition: rule to agree with Christian, NOT coded

Current live behaviour:
- Commission is credited to the agent wallet **at accrual**: `agent_commission_earned` wallet
  cash_in, 13,121 rows / UGX 74.6M in 30 days, plus `agent_commission` at 4,109 / UGX 12.5M.
- The income statement (`useFinancialStatements.ts:686`) books commission expense at accrual from
  platform `agent_commission_payable`/`agent_commission`/`agent_payout`.
- Agent "earnings" views sum the wallet credits.
- Actual commission withdrawals in the same 30 days: 25 rows / UGX 5.5M.

The requested rule: money landing in the agent wallet is **not** revenue. Recognition happens only
when (1) the agent withdraws, (2) the OTP is entered, and (3) the landlord has received the money.

Open questions to settle with Christian before anyone writes code:
- Whose revenue is it? Welile's commission *expense* recognition, the agent's *earnings* figure, or both?
- Does (3) mean commission is only recognised when used for a landlord payout (the OTP + merchant
  flow, `landlord_payouts` → `awaiting_agent_receipt`)? And what about a plain cash withdrawal to
  the agent's own MoMo, which has no landlord?
- What happens to commission that is credited but never withdrawn: a liability (payable), or clawback?
- Is it reporting-only (reclassify at read time), or does the ledger itself post accrual → payable →
  recognised legs? The live categories `agent_commission_accrued`/`agent_commission_settled`
  already exist (17 rows) and may be the start of the latter.

The evidence hook for (2)+(3) already exists and is live: `rent_request_landlord_paid_by_merchant()`
(doc 117) and `landlord_payout_otp_challenges.verified_at`.

## Recommended order
1. Top up Yoola (ops, today).
2. Decide on the direct-tenant-rent migration and reclassifying the ~114 payments.
3. Close the `cfo-direct-credit` cross-user TID hole and decide on recovering the UGX 300k double credit.
4. Wallet-transfer idempotency key plus per-sender lock (patch + verify; ledger-touching).
5. Build `get_reconciliation_exceptions`, and fix the `deposit_match_alerts` CHECK constraint.
6. Commission rule, after agreeing it with Christian.

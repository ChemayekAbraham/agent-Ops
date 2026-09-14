# Withdrawal payout-account lock (2026-09-13)

**Read this when:** a user disputes a wallet withdrawal paid to a number they didn't recognize, or
before touching `enforce_withdrawal_payout_account_lock`, `submit_withdrawal_request`, or the
registered-payout-number lock behavior in `WithdrawFlow.tsx`.

## The gap

CASE MP-20260913-01: a user's disputed UGX 1,500,000 withdrawal was paid to a number that never
appeared on his registered account. `WithdrawFlow.tsx` renders the registered payout number
**read-only** once one is set on the account — but that lock only ever existed in the React UI.
Every trigger on `withdrawal_requests` was read directly and confirmed: none of them compared the
request's `mobile_money_number` against the account's registered `profiles.mobile_money_number`.
`trg_enforce_no_fraud_withdrawal_request` only checks frozen/blocklist status. A request could
carry **any** payout number regardless of what the screen showed as locked — the front-end promise
was never a guarantee.

## The fix (`20260913190000_enforce_withdrawal_payout_account_lock.sql`)

A `BEFORE INSERT OR UPDATE OF mobile_money_number` trigger,
`enforce_withdrawal_payout_account_lock()`, on `withdrawal_requests`:

- Only fires when `payout_method = 'mobile_money'` and `reason ILIKE '%wallet withdrawal%'` —
  **deliberately narrow scope**. Landlord float payouts, proxy withdrawals, and any other
  withdrawal reason are untouched; this migration did not have enough context on those flows'
  legitimate use of third-party payout numbers to safely extend the lock to them.
- Only blocks when the account **already has** a registered `mobile_money_number` AND
  `mobile_money_name` on `profiles` — matching exactly the condition under which the app's own
  screen renders the number read-only. No registered number yet → the app's free-entry path
  applies, nothing to lock against.
- Compares numbers on their **last 9 digits**, so `256776368807` / `0776368807` /
  `+256 776 368807` are recognised as the same number regardless of format.
- On a mismatch, raises `SQLSTATE 28000` (`withdrawal_payout_account_locked`) with a `DETAIL`
  message naming the registered number/name and telling the user to change their registered
  Withdrawal Account in Settings first.

**Verified against the last 7 days of live data before deploying**: 53 requests would pass on an
exact match, 307 had no locked account yet and pass by design, 11 would have been blocked — in the
same ballpark as a separate ~30-day platform-wide sweep from the same investigation, which
independently found 3 accounts fitting this exact fraud signature.

## Follow-up: blocked attempts were briefly forensically invisible

During an unrelated adversarial-regression pass on 2026-09-14 (see
[`13-ip-actor-audit-instrumentation.md`](./13-ip-actor-audit-instrumentation.md)), a real gap was
found and fixed: a **blocked** attempt raised the exception and rejected the insert, but left **zero
forensic trace anywhere** — no `withdrawal_requests` row (it never committed) and, when a fix was
first attempted by logging directly inside this trigger right before the `RAISE EXCEPTION`, that
log row was *also* silently undone, because `RAISE EXCEPTION` aborts the entire enclosing
transaction, including anything inserted moments earlier in the same trigger invocation. Confirmed
empirically against a real (non-rolled-back) attempt: zero rows landed in `audit_logs`.

The trigger above is back to its original, simple form (no logging inside it — that approach is
proven not to work in this database, which has no `dblink`/`postgres_fdw` for an
autonomous-transaction workaround). The actual fix lives in **`submit_withdrawal_request`**, the
sole writer of `withdrawal_requests`: its own `EXCEPTION WHEN invalid_authorization_specification`
handler now logs the blocked attempt to `audit_logs` (action_type
`withdrawal_payout_account_lock_blocked`) with the real client IP, because PL/pgSQL's
exception-handling rolls back to a savepoint and then runs the `WHEN` clause's own code in the
*recovered* transaction — code written there commits normally.

## If you touch this again

- If you extend this lock to another withdrawal reason (landlord float, proxy, etc.), re-verify
  those flows don't have a legitimate reason to pay a third-party number first.
- `submit_withdrawal_request` is the **only** current writer of `withdrawal_requests` — confirmed
  via a full-text search of `pg_proc` for `INSERT INTO public.withdrawal_requests`. If a second
  writer is ever added, it needs its own catch-and-log for `invalid_authorization_specification`,
  or blocked attempts through that path will silently vanish again.
- Never try to log something from *inside* a trigger function immediately before a `RAISE
  EXCEPTION` in this database and expect it to survive — it won't. Log it in the exception
  handler of whichever caller can actually catch the error instead.

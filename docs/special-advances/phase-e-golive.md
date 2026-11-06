# Special Advances readiness, Phase E: go-live

Status as at 2026-11-02: tools built on `sarah-dev`; **issuance is OFF** and stays off until the CFO switches it on as
the last step below. Nothing in this phase changes production by itself.

## What Phase E adds

- **Concurrency tests on a real Postgres** (`src/test/specialAdvanceConcurrency.test.ts`, run with
  `node scripts/run-special-advances-concurrency.mjs`, which creates a throwaway local cluster, applies Phases 1-4 and
  A-D with the real ledger code, runs every race on separate connections, then deletes the cluster). 8/8 pass
  (2026-11-02, PostgreSQL 18.6 local; production is 17.11):
  - the same payout sent 8 times at once posts once (one ledger group, one wallet credit);
  - 8 simultaneous repayments that together exceed the balance: exactly what fits is recorded, the rest are refused;
  - the same repayment request (same key) 8 times: recorded once, 7 replays;
  - one provider reference with 8 different keys: booked once;
  - 8 simultaneous corrections of one repayment (different keys): one posting; the same request 8 times: one posting,
    7 replays;
  - a repayment racing a write-off: exactly one of them goes through; the books tie;
  - 8 simultaneous provision postings: exactly one posts; the others find nothing left to post;
  - afterwards every Special Advances ledger group nets to zero raw and on the mapping, A24 / A25 reconcile, and the
    balance-sheet memo equals A24.
  Without `SA_PG_URL` the test is skipped, so normal test runs and CI are unaffected.
- **Read-only go-live check** (`supabase/tests/special_advances_golive_check.sql`): one SELECT, run inside a read-only
  transaction, returning `ready` and every item with ok / detail. It checks migrations recorded, function fingerprints
  (Phases 4, B, C, D), tables, accounts A24 / A25, the 12 mappings and allowlist entries, the storage policies (two,
  CFO only, no update / delete, no authenticator clause), the proof bucket, the number of enabled CFO accounts (Welile
  has one) and that Special Advances no longer require an authenticator, A24 against the
  paid-out outstanding, every Special Advances ledger group netting to zero, the one-step workflow (no request,
  decision or queue function), grants, and the
  issuance switch.

## Result against production now (read-only, 2026-11-02)

`ready: false`. Passing: Phases 1-4 and A recorded; payout and ledger posting fingerprints; grants closed; A24 = 0 =
records; issuance off; no advances. Not yet done: Phases B, C, D not applied; storage policies not applied; **0 of 4
enabled CFOs have a verified authenticator**.

## Go-live sequence (each step needs the CFO's explicit approval)

1. **Screens:** proof upload on payout / repayment /
   correction / write-off / recovery; correction, provision-review and write-off queues; detail-sheet additions
   (Phase A, B, C hand-offs). Published by Lovable.
2. **Project owner:** apply the two proof storage policies
   (`docs/special-advances/phase-a-readiness.md`); Claude verifies them read-only.
3. **CFO roles:** only the one CFO keeps an enabled `cfo` role (any CFO account can act alone). No authenticator is
   needed (decision 2026-11-03); apply `20261103150000` with the CFO's approval.
4. **Apply** Phase B (`20261102210000`), then Phase C (`20261102220000`), and Phase D (`20261102230000`), each by CLI in
   one transaction with its `schema_migrations` row, each preceded and followed by a read-only check (same method as
   Phase 4 and Phase A).
5. **Run the go-live check** read-only: `ready` must be `true`.
6. **Switch issuance on.** No browser path exists; only the database owner can change it. With the CFO's approval:
   ```sql
   -- one transaction; record who approved it
   UPDATE public.special_advance_settings
      SET issuance_enabled = true, updated_by = '<approving CFO user id>', updated_at = now(),
          note = 'Switched on <date> with CFO approval after the go-live check passed';
   ```
   **Switching off** is the same statement with `false` and a note; it stops new agreements, approvals and payouts
   immediately and leaves repayments, corrections, provisions and write-offs working.
7. **Pilot:** one small advance (e.g. UGX 10,000-50,000, 7 days) to a consenting Welile account, approved by one CFO
   and paid out, then repaid in two parts with proof files. After each step, read-only: the ledger group balances raw
   and on the mapping; `special_advance_reconciliation()` is balanced; A1 in `get_treasury_cash_position` moves by the
   cash legs; the balance-sheet memo equals A24.
8. **Monitor** for the first month: the go-live check and the reconciliation after every payout and at each month-end
   provision review.

## Gaps stated plainly

- The concurrency run used PostgreSQL 18.6 (the only local version); production is 17.11. The functions use only
  long-standing features (row locks, advisory locks, unique indexes), but it is not proven on 17.
- Supabase's PostgREST, Auth and Storage layers are not in the local runs: real sign-in sessions and real uploads are
  proven only in the pilot.
- Whether TOTP is enabled in the project's Auth settings is not visible from SQL.

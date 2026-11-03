# Special Advances readiness, Phase D: reporting

Status as at 2026-11-02: built on `sarah-dev`, **not applied** to production. Production apply needs explicit CFO
approval. Migration `supabase/migrations/20261102230000_sofp_special_advances_memo.sql`, rollback
`supabase/rollbacks/20261102230000_sofp_special_advances_memo.rollback.sql`, tests
`src/test/specialAdvanceSofpMemo.test.ts`, production fixture `scripts/fixtures/sofp-prod-2026-11-02.sql`.

## CFO decision D12 (2026-11-02)

Show Special Advances in the balance sheet's memo of operational sub-ledgers (`get_statement_of_financial_position`
→ `reconciliation.memo_sub_ledgers`). Comparison lines only: no balance, heading, total, mapping or posting changes.

## What changes

- New internal helper `_special_advance_sofp_memo(p_as_at)` (no client execute) returns:
  - **Special Advances outstanding (paid out)**: current operational outstanding of advances paid out on or before the
    statement date — compare with ledger account A24;
  - once Phase C (`20261102220000`) is applied, also **impairment allowance** (compare with A25) and **net receivable**
    (A24 less A25).
  Approved-but-unpaid advances are never counted (Phase A).
- `get_statement_of_financial_position` is the production definition **verbatim** plus one statement appending those
  lines to the memo. The preflight pins production's fingerprint (`2ee44b04…`) and settings; the rollback restores it
  exactly.
- Applies before or after Phase C (the helper checks for the allowance function at run time). Requires Phase A / Phase 4.

## Verified locally (production statement and resolver, verbatim)

- Every balance, total, trial-balance figure and existing memo line is identical before and after; only the three
  Special Advances lines are appended.
- The memo ties to the statement's own A24 and A25 lines and to `special_advance_reconciliation()` (example: outstanding
  1,105,000 = A24; allowance 444,000 = A25; net 661,000).
- Access unchanged: finance roles only (`cfo`, `ceo`, `coo`, `manager`, `financial_ops`, `super_admin`, `cto`) — they
  already see the A24 / A25 lines; the helper is not callable by clients.
- Rollback restores the production definition exactly.

## Screens

No UI change is needed for the memo: `BalanceSheetPanel.tsx` already lists, exports and prints every memo line. The
Special Advances reconciliation tile (gross A24, allowance A25, net) is in the Phase C Gemini hand-off.

# Add `staff_loan_repayment` to the ledger category allowlist

ECHO TAG: LEDGER-CATEGORY-LOAN-2026-09-21-Z

## Current state (verified live, read-only)

- `public.ledger_category_allowlist()` holds exactly **125** categories — matches the guard in the supplied SQL, so it will not abort.
- `public.validate_ledger_category('staff_loan_repayment')` returns **false** today, so the new category is genuinely missing.

## What will be done

1. Create exactly **one** new migration file containing the supplied `do $mig$ ... $mig$;` block verbatim — no hand-typed category list, no edits to the SQL.
2. Apply it to production in a single transaction.
3. Report only: the migration file path, the commit SHA, and the exact `NOTICE` text.

Expected notice: `LEDGER-CATEGORY-LOAN-2026-09-21-Z PASSED — 126 categories, was 125`

## Scope fence (respected)

Nothing under `src/` will be opened or changed. No edge function, existing migration, cron job, `treasury_controls` row, or `strict_mode` setting is touched. No other function, trigger, table, view or policy is altered. Nothing touching payroll advances, facilitation, ENGREP, call centre (`cc_*` / `crm_*`), concerns, referrals or job applications. No developer update is run.

If the scanner, type checker or build reports anything, work stops and it is reported as-is — no fixes, no deletions.

## Technical detail

The block re-creates `ledger_category_allowlist()` by reading its own current output, unioning `'staff_loan_repayment'`, de-duplicating and sorting, then re-emitting the array via dynamic SQL. Built-in assertions: pre-count must be 125; post-count must be 126; the new category must validate; and five existing categories (`salary_payout`, `facilitation_disbursement`, `rent_repayment`, `wallet_withdrawal`, `🔧 Manual Adjustment`) must still validate. Any failure raises and rolls back the whole transaction.

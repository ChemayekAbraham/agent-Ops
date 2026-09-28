# Release candidate freeze — Rent Repayment Waterfall + Accounting Correction

Frozen: 2026-09-28 23:15 UTC
Freeze point (only authorized version): `e5757f21d71f2dcad55ddfa76f95a5877bc8c776`

## Included files (and nothing else)
| File | sha256 |
|---|---|
| docs/pending-migrations/rent_plan_four_part_accounting_alignment.sql | da235619219238b29dcb4e0211d28acaa603f2fb4ce5d77768b45ebacd2d012f |
| docs/pending-changes/agent-deposit-commission-idempotency.md | dac0ba3ab7bcd8ecc083e4fafa7f416ff1a2cd8d6c3e5439d60c5b426c43f222 |

No Edge Function, app code, or `supabase/migrations/` file is part of this release.

## Live state at freeze (read-only check)
- Draft migration not in migration history; its new functions absent; 0 `platform_fee` ledger lines.
- 16-collection correction: staged, unapplied.
- Agent-deposit retry fix: staged, unapplied.

## Later release process (only on explicit written authorization)
1. Confirm HEAD / file hashes equal the values above; abort on any mismatch.
2. Fingerprint database: `public.user_roles.enabled` must exist (RentFlow).
3. Apply the SQL file verbatim as one migration. Do not edit.
4. Run `npm run guard:all`.
5. Run correction preview, then `rent_fee_correct_unsplit_agent_collections` once; expect 16 rows, UGX 841,111, 64 balanced lines; re-run must add 0.
6. Retry fix: apply separately only if separately authorized.

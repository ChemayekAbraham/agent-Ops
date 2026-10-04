# 177 - DB CPU report verified against live; last_active write throttled

**Frontend change BUILT 2026-10-01; migration 20260930200000 (doc 175) is STILL NOT APPLIED on production.**

## Why
An outside DB performance report (2026-10-01) listed ~12 request types as the CPU cost. Each was checked
against the live database before building anything.

## Verified live (2026-10-01)
- **Doc 175 not applied.** `pg_policies` for `promissory_notes` / `user_roles` still show bare
  `auth.uid()`, per-row `EXISTS (SELECT ... FROM user_roles)` and 5x `has_role()`. Items 1 and 3 of the
  report are therefore still open on production; the fix is already in the repo and needs applying.
- **Item 5 (name search index) already exists.** `profiles` has `idx_profiles_full_name_trgm`,
  `profiles_full_name_trgm` (duplicates) and `profiles_name_fts`. A new index would only add write cost.
  The slow query is a query-shape problem, not a missing index. `profiles` carries many duplicate indexes
  (created_at x2, last_active x2, email_trgm x2, full_name_trgm x2, phone_trgm x2); dropping duplicates
  would cut write cost but is not done here.
- **Item 7 indexes are not worth building.** `agent_commission_payouts` has 56 rows and
  `merchant_out_of_pocket_advances` 3,408, so a date index cannot explain 4.4s / 0.45s (look at RLS/locks).
  The "frozen accounts" partial index is not selective: 38,151 of 97,020 profiles are frozen (39%).
- `pg_stat_statements` was reset 2026-10-01 05:35 UTC, so the report's call counts cannot be re-measured yet.

## Changed
`src/hooks/useAuth.tsx`: the `last_active_at` write ran on every `SIGNED_IN`, which supabase-js also fires
on tab resume. Now at most once per 15 min per user (localStorage key `last_active_written:<uid>`; if
storage is unavailable it still writes). Nothing else reads the exact timestamp more finely than that.

## Still open
- Apply doc 175's migration, then re-measure `promissory_notes` counts and `user_roles` lookups.
- Item 2 (pre-compute `get_merchant_float_positions` / `get_merchant_float_ledger_variance`, 3.1s / 6.7s
  live): needs a cache table + cron design; both functions are ledger-adjacent, so not done blind.
- Items 1b and 4 (exact counts on notes screens and available houses): UI-side, `count: 'estimated'` or a
  summary RPC.

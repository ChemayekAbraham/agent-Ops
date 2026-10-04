# 175 - promissory_notes / user_roles RLS re-ran role checks per row (DB CPU)

**BUILT 2026-09-30, not yet applied.** Verify live with the queries at the bottom after applying.

## Problem
Supabase performance report: counting `promissory_notes` was ~30% of all DB time (26,100 runs, avg 1.2s,
max 8s) on a 2,130-row table, and `user_roles` lookups averaged 6.6s. Cause is RLS, not data volume:
- `promissory_notes` admin policies ran `EXISTS (SELECT ... FROM user_roles ...)` per row, which also fired
  `user_roles`' own SELECT policy.
- `user_roles` "Users can view roles" called `has_role()` 5 times per row.

## Fix (migration 20260930200000)
Two SECURITY DEFINER STABLE helpers, called as `(SELECT helper(...))` so Postgres evaluates them once per
statement (InitPlan), and `auth.uid()` wrapped the same way:
- `current_user_has_any_role_ignoring_enabled(app_role[])` - mirrors the old promissory_notes subquery,
  which never checked `user_roles.enabled`.
- `current_user_has_enabled_role(app_role[])` - mirrors `has_role()` (checks `enabled`).
Policies rewritten with `ALTER POLICY` (names unchanged). **Access rules are identical; no behaviour change.**
Not touched: `has_role` (drift-watched), user_roles write policies (low volume).

## Noted, deliberately not changed
promissory_notes admin policies ignore `user_roles.enabled`, so a disabled staff role still grants access.
Likely an existing bug; fixing it is a behaviour change and needs a decision.

## Still open from the same report
Merchant float reports pre-compute (2), counts/estimates for notes and available houses (1, 4), name-search
trigram index (5), throttle last-active writes (6), date and frozen-accounts indexes (7).

## Verify after applying
- `select polname from pg_policies` shows the new `(SELECT ...)` form for the 8 policies.
- Staff (e.g. partner_ops) still sees all notes; an agent sees only their own; `EXPLAIN` shows InitPlan.

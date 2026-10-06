# 193 - Proxy Withdrawal Diagnostics: ambiguous `amount` fixed, and what the panel really lists

**Date:** 2026-10-02 · **Scope:** `supabase/migrations/20261002175000_fix_diagnose_proxy_withdrawals_ambiguous_amount.sql` (function body only). **Already applied to production** by hand on 2026-10-02; the file is committed so the repo matches the database.

## Problem
`diagnose_pending_proxy_withdrawals()` failed with `column reference "amount" is ambiguous`, so the Financial Ops "Proxy Withdrawal Diagnostics" panel did not load. The function is `RETURNS TABLE(... amount, status, created_at ...)`; in plpgsql those output columns are variables for the whole body, and the first statement read `amount` and `bulk_payout_allocated_total` from `gmail_transactions` without an alias.

## Fix
Alias `gmail_transactions` as `gt` and qualify its columns. Nothing else changes. The panel (`ProxyWithdrawalDiagnosticsPanel.tsx`) calls the same function name, so no app change.

## Verified against production (2026-10-02 ~17:30 EAT)
- Live body matches the file; the function runs and returns rows.
- Open bulk e-mails: 12, remaining capacity UGX 126,716,525, recomputed from `gmail_transactions` without the function. Capacity is not the blocker.
- 35 open withdrawals (all `pending`, UGX 16,240,000), all `payout_method = mobile_money`, none bank.

## Migration version clash, fixed
The hand-applied file was first saved as `20261002150000_...`, the same version as doc 190's `20261002150000_search_users_fast_welile_id.sql`. Renamed to `20261002175000` before commit so two files do not share a version. The function body is identical, so this is safe to apply twice (CREATE OR REPLACE).

## What the panel actually lists (not fixed here)
- It is not limited to proxy partners. The `wr` CTE takes every withdrawal in `pending`, `manager_approved`, `cfo_approved`. Only 5 of the 35 belong to a partner with an active approved proxy assignment; 30 are ordinary withdrawals. `proxy_partner_id` is empty on all 35.
- The `not_bank_payout` check runs before the proxy check, so every mobile-money row shows that reason. It says the bank auto-settle does not apply. It does not say why the withdrawal is still pending.

## Open
1. Scope the function to partners with an active approved proxy assignment (or rename the panel). Changes what staff see, needs a migration.
2. Find out why 35 mobile-money withdrawals (UGX 16.24M) are still `pending`. Not answered by this panel.

## Architecture map
No update: a function-body fix, no new data flow.

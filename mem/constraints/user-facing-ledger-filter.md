---
name: User-facing ledger filter
description: End-user wallet views/balance RPCs filter admin_correction+system_balance_correction CREDITS only; DEBITS pass through so CFO reductions actually shrink withdrawable. Production reversals stay visible.
type: constraint
---
End-user wallet balance reads (`v_user_wallet_strict`, `get_user_wallet_view`, `get_user_available_balance`, and any frontend `general_ledger` query that drives a user-visible figure) MUST exclude rows that are BOTH `classification = 'admin_correction'` AND `category = 'system_balance_correction'` AND `direction IN ('credit','cash_in')`. Admin correction DEBITS of `system_balance_correction` MUST be kept so CFO reductions actually neutralize phantom withdrawable (root cause of the PC020 / Onesmus 513,300 incident — 2026-05-19).

They MUST NOT exclude `system_balance_correction` rows that are classified `production` — those are legitimate operational reversals (e.g., reversing a bogus pending top-up wallet credit, payroll-growth credits) and they have to count toward the user's balance, otherwise the user sees a phantom balance that the cache doesn't have.

**Why:** Prior to 2026-05-05 the filter was a blanket `category <> 'system_balance_correction'`, which silently dropped production reversals. Real-world impact: tenant LUYIMA SOLOMON SAMUEL (`22f6cdf9-…`) saw UGX 100,000 withdrawable that did not exist — the April 17 production reversal of his parked top-up was being filtered out.

**How to apply:**
- SQL: keep row IF `classification IS NULL OR classification='production' OR (classification='admin_correction' AND category='system_balance_correction' AND direction IN ('debit','cash_out'))`
- Supabase JS (frontend): exclude only the credit leg of admin system_balance_correction; let debit legs through.

CFO/ops dashboards remain exempt and may include all classifications.

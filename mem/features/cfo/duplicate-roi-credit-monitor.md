---
name: Duplicate ROI Credit Monitor
description: CFO report + proactive alert flagging investor ROI credited twice to the same portfolio/cycle within seconds (double-submitted proxy payouts)
type: feature
---
`get_duplicate_roi_credits(p_window_seconds int default 120, p_lookback_days int default 30)` (SECURITY DEFINER, search_path=public, granted to authenticated + service_role) scans `general_ledger` for `category='roi_wallet_credit'` + `source_table='investor_portfolios'` rows, partitions by `(source_id, month)`, and flags portfolio+cycle groups with >1 credit where the smallest consecutive gap ≤ window. Returns portfolio_code, beneficiary_name (investor_portfolios.investor_id → profiles), proxy_wallet_user_id, credit_count, total_amount, excess_amount (= total − max single), first/last credit time, min_gap_seconds, ledger_ids[], ledger_references[].

UI (CFO dashboard):
- `DuplicateRoiCreditsPanel` — full report in the Reconciliation tab (tunable window/lookback, total-excess banner, copy refs). Alongside `PhantomCorrectionDriftPanel`.
- `DuplicateRoiCreditAlert` — proactive red banner rendered on every CFO tab (above content) when count>0; clicking jumps to Reconciliation. Polls every 5 min.

Root cause it catches: `roi_wallet_credit` legs carry NO idempotency_key, so rapid double-submits in the ROI payout tool credit the proxy wallet twice, which then gets withdrawn as one inflated payout (e.g. GINA LIZ portfolio WIP2604094753: 2×150K on 2026-07-07 08:24 → single 300K cash-out). Merchant cash-out agents are NOT at fault — they pay the request amount.

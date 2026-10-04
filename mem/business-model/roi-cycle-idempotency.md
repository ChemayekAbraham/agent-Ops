---
name: ROI Payout Cycle Idempotency
description: A portfolio can receive its ROI only once per payout cycle; duplicate/repeated ROI credits are blocked at the approval + ledger boundary
type: feature
---
**Rule:** one ROI credit per portfolio per payout cycle. The cycle is keyed by the portfolio's current `next_roi_date` (which only advances after an ROI approval), so accidental double-submits or repeated executions resolve to the SAME key and the second is refused.

**Idempotency key:** `roi-cycle-<portfolio_id>-<next_roi_date>` (falls back to `roi-cycle-<portfolio_id>-<YYYY-MM-DD today>` if next_roi_date is null).

**Enforcement (defense in depth):**
0. **DB trigger `trg_enforce_roi_cycle_once` on `pending_wallet_operations` BEFORE INSERT (tamper-proof floor)**: for any inserted row with `category='roi_payout'` + `source_table='investor_portfolios'`, function `enforce_roi_cycle_once` resolves the cycle key from the portfolio's current `next_roi_date` and RAISES `unique_violation` if (a) a `general_ledger` row already has that `idempotency_key` (already credited this cycle) or (b) another open `roi_payout` `pending_wallet_operations` row exists for the same portfolio (statuses pending/pending_coo_approval/coo_approved/awaiting_verification). This runs at the database, so it blocks a duplicate ROI request even if the UI list-hiding is bypassed, "Show them" is toggled, or the client is tampered with. Client insert surfaces the raised message via `toast.error`.
1. `approve-wallet-operation` edge fn (authoritative, covers all approval-based `roi_payout`/`supporter_platform_rewards` credits incl. managed-proxy + split cash leg):
   - Pre-check: if any `general_ledger` row already has that `idempotency_key`, the pending op is set `status='rejected'` (metadata.duplicate_roi_blocked) and skipped — no credit.
   - The ROI `create_ledger_transaction` call passes `idempotency_key: roiCycleKey`. `create_ledger_transaction` already advisory-locks + returns the existing group WITHOUT posting on a key hit.
   - Race guard: after the RPC, if the key's earliest row predates this invocation (`ledgerPostStart − 1500ms`), it was a concurrent idempotent hit → reject + `continue` BEFORE the wallet delta-recovery (which would otherwise re-credit via apply_wallet_movement).
2. Client `COOPartnersPage.handlePay` + `handleSplitPayout`: pre-flight block if (a) a ledger row with the cycle key exists, or (b) an open `pending_wallet_operations` (status pending/pending_coo_approval/coo_approved/awaiting_verification, category roi_payout) already exists for the portfolio. Clear toast, no duplicate pending op created.
3. **List-level hiding (COOPartnersPage `NearingPayoutsDialog`)**: after building the nearing-payouts list, `fetchNearingPayoutsAsync` batch-queries `general_ledger` for each portfolio's cycle key AND open `pending_wallet_operations` (same statuses/category), stamping `alreadyProcessedThisCycle` + `processedState` ('credited'|'pending') on each row. The payout list FILTERS these out by default so a paid/pending portfolio disappears from the payable list entirely (prevents double credit at the source). A green banner shows the hidden count with a "Show them" toggle; when shown they render read-only with a locked "already credited/pending this cycle" badge and no action buttons.

Historical ROI rows have null idempotency_key so there are no false positives. Detection/report of past duplicates: `get_duplicate_roi_credits` + CFO Duplicate ROI Credit Monitor (see mem://features/cfo/duplicate-roi-credit-monitor).

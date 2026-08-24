---
name: Bulk advance reversal
description: CFO bulk reversal of disbursed agent advances — advance_reversal_plan_batch preview + chunked bulk-reverse-agent-advances edge function
type: feature
---
Bulk reversal of disbursed agent advances (added 2026-08-24, after 191 advances totalling UGX 9,327,000 were auto-credited at 06:00 via the now-closed CFO skip path):

- `advance_reversal_plan_batch(p_advance_ids uuid[], p_today_only boolean)` — read-only, CFO/manager only. One round trip returns, per advance: agent name/phone, principal, disbursed (ledger `agent_advance_credit`, wallet scope), already recovered (`cfo_debit_obligations` tagged `advance_reversal:<id>`), amount_to_reverse, withdrawable (`get_user_available_balance`), recoverable_now, shortfall. With no ids it lists today's un-reversed advances.
- Edge function `bulk-reverse-agent-advances` — max 25 advance ids per call (client chunks and shows progress). Per advance it runs the SAME pair as the single dialog: CFO Direct Debit clawback via `cfo-direct-credit` (operation `debit`, `sub_category: advance_reversal:<id>`) for `recoverable_now`, then `reverse_agent_advance` RPC. Uses a caller-scoped client so `auth.uid()` authorisation still applies; forwards the caller's Authorization header to `cfo-direct-credit`.
- One `clawback_group_id` is generated client-side per batch and passed to every advance, so a batch is traceable as a single event.
- Per-advance try/catch: one failure never aborts the batch. Outcomes are `reversed` / `skipped` (already reversed, outside same-day window, no originating request) / `error`.
- Wallets are never driven negative; the uncollected part is stored as an unrecovered shortfall on the advance + audit log. UI exports shortfalls/failures as CSV.
- UI: `BulkReverseAdvancesDialog.tsx` + checkbox selection and "Reverse today's batch" toolbar in `DisbursedAdvancesRegister.tsx`.

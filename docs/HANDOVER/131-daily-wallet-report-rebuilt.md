# 131 — Daily Wallet report rebuilt (compute_wallet_report v2)

**Built and committed 2026-09-25. NOT live until migration `20260925090000` is applied AND the
`generate-daily-wallet-report` edge function is redeployed. Ship both together:** the new edge
function refuses a v1 payload, and the old one would print v2 numbers under the old labels.
Read this before quoting any figure from the "Daily Wallet Financial Summary" email (sent at
00:00, 06:00 and 12:00 EAT), or before touching `compute_wallet_report`.

## Why it was destroyed

The CEO received the 24 Sep report (deposited 68.24M, paid out 21.36M, "Closing Wallet Balance"
46.88M) and asked if it was right. It matched the ledger to the shilling. As a money report,
though, it was wrong:

| v1 line | What it actually contained |
|---|---|
| "Other" deposits 22.08M | 20.5M was **float WELILE sent to agents** (`merchant_float_deliveries`) plus 1.58M of `merchant_float_reconciliations`. That is our own money going out, counted as money in. |
| "MTN via Gmail" 21.85M | Includes Mercy Bayo's 14.9M Airtel→MTN treasury swap. |
| "CFO Direct Credit" 5.96M | Credits posted by hand, listed as if they were money received. |
| Total paid out 21.36M | Only counted `wallet_withdrawal`, which posts when the user's wallet is **debited**, not when cash leaves. It missed 11.72M that agents paid out of float that day (`agent_float_settlement`). |
| "Merchant Agent Equity Bank Account" 16.6M | Every `bank_transfer` payout: Stanbic, StanChart, Centenary and Equity. 14 of the 15 went through Kabahuma Lillian. |
| "Closing Wallet Balance" 46.88M | Deposits minus payouts. It is not a balance anyone holds. The phone lines had about 5.07M at midnight. |

Following [[feedback_delete_rebuild_vs_patch_policy]], this is reporting code with eroded trust, so
the function was dropped and rebuilt rather than patched. It is read-only. Nothing in the ledger
or the wallets changes.

## v2 buckets (never double count)

- **money_in**: `agent_float_deposit`/`wallet_deposit` wallet credits sourced from `deposit_requests`
  (by provider), field-cash sources, and `gmail_transactions` auto-credits.
  `money_in_from_exec_staff` is the subset credited to ceo/cfo/coo/cto/cmo/financial_ops/super_admin
  accounts. It is shown so treasury swaps are visible. It is a flag, not a fraud signal.
- **manual_credits**: `cfo_direct_credit`, `ledger_transaction`/`general_ledger` adjustments,
  `manual_recovery`, and anything unclassified.
- **float_to_agents**: `merchant_float_deliveries` + `merchant_float_reconciliations`, with a
  per-recipient list. Internal.
- **payouts**:
  - `agent_paid`: every `agent_float_settlement` wallet leg in the window, split into principal
    (leg = withdrawal amount) and fee (the telecom charge, part of the same float debit per
    [[project-telecom-charge-is-part-of-float-debit]]).
  - `treasury_*`: `wallet_withdrawal` legs whose withdrawal was **never** float-settled, by
    bank_transfer / mtn / airtel, plus a normalised bank breakdown.
  - An agent-settled withdrawal is counted once, on the day the agent paid it.
- **net_movement** = money_in_total − payouts_total. It is labelled as a movement, not a balance.
- **internal_movements**: wallet → Rent Plan portfolios (`partner_funding`) and agent float used
  for rent collection. Informational only.
- **provider_sms**: an independent cross-check from `gmail_transactions` (in/out per line,
  inbound SMS not linked to any deposit, top 10 outgoing counterparties).
- **phone_float_at_end**: the last SMS-reported balance per line at or before the period end.
- **top_deposits**: the 10 largest depositors, with the staff-account flag.

The RPC now also enforces the same role gate as the `daily_wallet_reports` RLS policy (cfo,
financial_ops, super_admin, manager, ceo, coo). v2 returns depositor names, and v1 was callable
by any signed-in user. Service-role callers (cron) have no `auth.uid()` and pass.

`daily_wallet_reports` gains `report jsonb` (the full v2 payload) and `report_version` (1 = old
rows, 2 = new). For v2 rows, `total_deposited` / `total_paid_out` / `closing_balance` hold
money_in_total / payouts_total / net_movement. **Historical v1 rows were left untouched.** Do not
compare v1 and v2 totals across the cutover.

## 24 Sep under v2 (verified against prod by running the function body read-only)

Money in 39,998,129 (MTN 21,846,100 · Airtel 18,152,029). 14,927,000 of that came from
exec/finance staff accounts. Paid out 28,816,500: agents paid 11,308,500 plus 410,300 in fees across
48 withdrawals, bank transfers 16,600,500 (15), treasury MTN 15,700, treasury Airtel 481,500.
Net +11,181,629. Float to agents 22,077,408. Manual credits 6,161,500. SMS: in 51.5M, of which 11.5M
(6 items) is not linked to a deposit; out 53.04M. Phone float at midnight 5,072,144.

## Files

- `supabase/migrations/20260925090000_rebuild_compute_wallet_report_v2.sql`
- `supabase/functions/generate-daily-wallet-report/index.ts`: one section model drives the
  HTML, text, XLSX and a paginated PDF. It stores `report` and `report_version`.
- `src/components/financial-ops/DailyWalletReportsPanel.tsx`: only the data mapping (`toMetrics`)
  and the money labels changed. "Closing Wallet Balance" is now "Net Movement (not a balance)".
- `src/integrations/supabase/types.ts`: the new columns.

`compute_wallet_report` is not in `critical_function_baselines`, so no re-baseline is needed.

## After deploying

1. Run `select (compute_wallet_report('2026-09-23 21:00+00','2026-09-24 21:00+00')->>'version')`. It should return `2`.
2. POST `{"date":"2026-09-24","skipEmail":true}` to `generate-daily-wallet-report`, then confirm the
   24 Sep row has `report_version = 2` and the figures above.

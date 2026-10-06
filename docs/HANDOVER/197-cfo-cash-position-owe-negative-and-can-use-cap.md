# 197 — CFO Cash Position: Money We Owe negative, Money We Can Use above Money We Have

**FIXED 2026-10-06, frontend data logic only (`CFOOverviewDashboard.tsx`). No migration, no RPC change.**

## Symptom
Cash Position screenshot, 1–6 Oct: Money We Have UGX 2,223,331,101, Money We Owe **−3,278,358**,
Money We Can Use UGX 2,226,609,459 (100.1% of Money We Have, i.e. more than we hold).

## Cause
`get_merchant_agent_money_owed` returns merchant float (floored at 0 per agent) plus
`bayo_mercy_total`, which is `money_at_bank_total` from `get_money_at_bank_reconciliation()`:
Equity-email credits less debits for the Bayo Mercy account since the 2026-09-07 cutoff, with no
floor. When extracted outflow exceeds inflow the figure goes negative, the card showed a negative
debt, and `Have − Owe` added it back. The existing `Math.max(0, …)` only floored Can Use at 0.

## Change
- Bayo Mercy component is floored at 0 for the headline (`bayoMercyOwed`).
- Money We Can Use is clamped to `0 … Money We Have`.
- The Money We Owe detail sheet (`MerchantAgentOwedSheet.tsx`) still reads the raw figure, so the
  negative stays visible there.

## NOT fixed / open
- **Why the Bayo balance is negative is unknown**: real overpayment to Mercy, or Equity inflow
  emails the classifier missed (it only counts emails naming Bayo/Mercy from `@equitybank`). The
  RPC is staff-role gated, so it could not be run from the query tool. Check `gmail_transactions`
  directly before treating the −3.28M as either.
- **Bank + Treasury ≠ Money We Have.** Verified live 2026-10-06: verified deposits at `bank` =
  2,216,492,843 (equals the Money in Bank card); at `cash_at_hand` = 2,750,000 (equals the gap).
  The Treasury card uses `outsideBankHeld` = MTN + Airtel + custody cash, the headline excludes
  custody. Not changed here.
- Money Paid Out / Received percentages compare a date-range flow to a balance (presentation, Gemini).
- Whether Can Use should subtract wallet obligations is a business decision.

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

## Why the Bayo balance goes negative (verified in `gmail_transactions`, 2026-10-06)
Not a missing email. Money moves Welile Technologies -> Mercy (Equity …7542) -> Catherine (…9292),
and Mercy pays Catherine **before** Welile's top-up lands. Replaying 28 Sep–6 Oct in order, the
balance dips below zero on 1 Oct (−14.8M), 2 Oct (−25.9M), 5 Oct (−8.6M) and 6 Oct (−24.9M) and
recovers after each top-up. The daily nets tie to the shilling. A negative balance is money Mercy
fronted from her own funds; that money is already inside the merchant float, so the commitment
is `float + max(0, bayo)` and the fronted amount must NOT be subtracted again (double count).
(The 90M 10 Sep issue is resolved and is not a cause.)

The arithmetic now lives in `src/lib/cashPosition.ts` (`computeCashPosition`, unit-tested) so no
page re-derives it. It also returns `mercyFrontedPendingTopUp` for display; surfacing it is a UI job.

## Known classifier leaks (not fixed, small)
- `get_money_at_bank_reconciliation` reads `channel = 'bank'` only. Mercy's own Equity -> MoMo
  transfers are tagged `mtn_momo` / `airtel_money` (5M on 2 Oct, 1M on 6 Oct) and are not counted
  as Mercy outflows.
- Welile MTN -> Mercy "Merchant Float" transfers (about 19M since 28 Sep) are outside her bank balance.
- The live card read −3.28M; replaying the 20260918 migration's logic gave −24.9M. Production
  likely runs a newer function version; the migration file is not the source of truth.

## NOT fixed / open
- **Bank + Treasury ≠ Money We Have.** Verified live 2026-10-06: verified deposits at `bank` =
  2,216,492,843 (equals the Money in Bank card); at `cash_at_hand` = 2,750,000 (equals the gap).
  The Treasury card uses `outsideBankHeld` = MTN + Airtel + custody cash, the headline excludes
  custody. Not changed here.
- Money Paid Out / Received percentages compare a date-range flow to a balance (presentation, Gemini).
- Whether Can Use should subtract wallet obligations is a business decision.

# Portfolio Return hold — runbook

Migration `supabase/migrations/20261024160000_portfolio_return_hold.sql` (rollback in `supabase/rollbacks/`).
**Not applied.** Temporary control while portfolios are investigated. The migration holds no portfolio; the CFO
approver places each hold.

## What a hold does

| Operation on a held portfolio | Effect |
|---|---|
| Compound, split, cash Return (including approving a request queued before the hold) | Refused at the ledger, nothing posted |
| New Return payout request, top-up request, wallet-to-investment request | Refused when queued |
| Instant / manual top-up, merge of parked top-ups | Refused (ledger and portfolio row); the daily merge job **skips** the portfolio and continues for all others |
| Change to principal, next Return date, mode, rate, total Returns, payout day, status, term, maturity, auto-reinvest, contribution date, partner | Refused, from every route (browser, edge function, cron, SQL) |
| Delete | Refused |
| Redemption, lock / unlock, split of principal, renewal | Refused (they change principal, status or dates); the renewal job logs it and moves on |
| Refund of a parked top-up to the partner's wallet | Allowed |
| Name / label edits, viewing | Allowed |
| Partner wallet withdrawals | **Not blocked** — the hold is on the portfolio, not the wallet |
| Return credits not tied to the portfolio (e.g. a CFO direct credit coded as a Return) | Not seen by the hold — closed by the Return-cycle guard |

Refusals carry `PORTFOLIO_ON_HOLD` (SQL state 42501).

## Place, review, release

```sql
-- CFO approver session only; reason at least 20 characters; audited as portfolio_return_hold_placed / _released
select public.place_portfolio_return_hold('<portfolio uuid>', '<reason>');
select public.release_portfolio_return_hold('<portfolio uuid>', '<reason>');
-- review
select h.*, p.portfolio_code from portfolio_return_holds h join investor_portfolios p on p.id = h.portfolio_id order by held_at desc;
```

A correction to a held portfolio: release, post the CFO-approved correction, place the hold again.

## Before applying

1. Confirm `merge_paidout_topups` is unchanged (the migration's precondition aborts otherwise).
2. Confirm the held portfolios have no auto-reinvest, no parked top-ups and no open requests that would be stranded.
3. Apply; then place holds one by one.

## Rollback

`supabase/rollbacks/20261024160000_portfolio_return_hold.rollback.sql` restores `merge_paidout_topups` exactly, drops
the triggers and functions, and keeps `portfolio_return_holds` as the audit record.

## Tests

`supabase/tests/portfolio_return_hold/run_hold_tests.mjs` — throwaway local Postgres (needs `embedded-postgres`, `pg`):
`node run_hold_tests.mjs <repo root>`.

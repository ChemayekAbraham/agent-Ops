# 133 — Next-day payout projection, emailed to the CEO nightly

**Status (2026-09-25):** built and committed, **not yet live**. Needs: migration
`20260925140000` (RPC) → deploy edge function `daily-payout-projection-report` →
migration `20260925140100` (cron). Verify all three after the push (see doc 06);
migrations here sometimes never auto-apply.

## What it does
Every evening at **18:00 Africa/Kampala** (cron `0 15 * * *` UTC,
`daily-payout-projection-report-1800-eat`) the CEO
(`benjaminmuhanguzi29@gmail.com`, CC `joshwanda17@gmail.com`) gets one email
covering all cash due to leave **the next day**:

| Stream | Source | What "tomorrow" means |
|---|---|---|
| Supporter Returns | `investor_portfolios.next_roi_date = tomorrow`, active | A real schedule. Split into cash payouts (grouped by bank / network, with account name and number, same shape as the WhatsApp payout sheet) and compounding (no cash). Frozen owners and portfolios with an open `REDEMPTION_REQUEST` are excluded, the same rules the Nearing Payouts panel uses. |
| Landlord payouts | `landlord_payouts` status `pending_merchant_payout`, plus `funded` Rent Plans from the last 14 days that have no `landlord_payouts` row yet | **No schedule exists**; this is the queue as it stands tonight. (`rent_requests.landlord_payout_next_run_at` looks like a schedule but has never run: `landlord_payout_last_run_at` is null everywhere.) |
| Wallet withdrawals | `withdrawal_requests` `pending`, or `approved` in the last 7 days, not frozen | The queue tonight. |
| Partner capital withdrawals | `investment_withdrawal_requests` open with `earliest_process_date <= tomorrow` | The notice period has ended. |

Older backlog goes at the bottom as **counts only, excluded from totals**:
Returns with a payout date already past, withdrawals approved more than 7 days
ago, and failed landlord payouts. On 2026-09-25 that was 52 past-due portfolios,
114 approved withdrawals (all older than 30 days, UGX 24.3M) and 107 failed
landlord payouts (UGX 74.7M). These are mostly settled outside the system; see
the memory notes on off-system settlement. Don't fold them into the "tomorrow"
figure.

## Flags printed at the top of the email
- **Early first payout**: a Returns payment due less than 25 days after funding.
  This catches the WIP2609245978 case (funded 2026-09-24, payout date hand-edited
  from 10-24 to 09-25, UGX 200,000 one day after funding). Payout dates can be
  edited straight from the browser (`COOPartnersPage.tsx` `handleSaveNextPayoutDate`)
  with no audit trail, and `portfolio_change_log` doesn't track `next_roi_date`.
- **No payout account/number on file.**

## Pieces
- `supabase/migrations/20260925140000_next_day_payout_projection.sql`:
  `get_next_day_payout_projection(p_date date default tomorrow-EAT)`,
  SECURITY DEFINER. Service role, or a signed-in ceo/cfo/coo/manager/super_admin;
  revoked from anon.
- `supabase/functions/daily-payout-projection-report/index.ts`: formats and
  sends through Mailgun, the same stack as the other daily reports. `date` / `to` / `cc` /
  `dry_run` overrides are honoured **only** for a signed-in executive, so the
  public anon key can't redirect payout details elsewhere or read them back.
- `supabase/migrations/20260925140100_schedule_daily_payout_projection_report.sql`: the cron.
- `src/hooks/useNextDayPayoutProjection.ts`: the same RPC for the in-app panel.
  **UI panel not built** (Gemini's lane). Recommended placement: CEO dashboard
  (`src/pages/ceo/Dashboard.tsx`) and CFO Overview.

## Dry run against production (2026-09-25, for 2026-09-26)
Returns: 21 portfolios (15 cash, 6 compounding, UGX 1,558,539 compounding),
matching the Nearing Payouts list. Three of them have no payout destination.
Landlord queue: 4 awaiting merchant payout (UGX 2,000,000) + 15 funded, not
started (UGX 3,450,000). Wallet withdrawals: 10 pending (UGX 3,023,700). Partner
capital: 9 (UGX 1,743,900).

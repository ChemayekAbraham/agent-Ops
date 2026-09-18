# 71 — Financial Ops "Landlord Float" bucket now shows today's obligation, not the total float held

**Migration written, blocked by the auto-mode classifier — needs manual apply, same as docs 66/69.
Before touching `get_wallet_bucket_totals()` or `WalletBucketsPanel.tsx`'s bucket #3 again.**

## What was reported

Josh, looking at the Financial Ops Wallet Buckets page: "YOU SEE THE 76M IN LANDLORD FLOAT BUCKET,
IT SHOULD SHOW THE AMOUNT WE ARE GOING TO PAY TODAY."

## What was found

The "Landlord Float" tile (`WalletBucketsPanel.tsx`, bucket #3) showed `landlord_float_total` from
`get_wallet_bucket_totals()`: `SUM(GREATEST(agent_landlord_float.balance, 0))` across every agent
— the full amount of cash currently sitting in every field agent's landlord-payout pool, live value
~80,257,727 (was 76M when Josh looked). This is a running balance, not a schedule — most of it is
backlog from earlier funding, not money that's actually going out today.

There was no existing "due today" concept anywhere in this subsystem to reuse:
- `landlord_payouts.sla_deadline` looked promising but doesn't work — all 926 pending
  (`awaiting_agent_receipt`) payouts, UGX 536,755,000, are already **past** their SLA deadline (max
  deadline was 2026-09-16), so it can't distinguish "today" from the whole overdue backlog.
- `landlord_ops_float_overview()` has no date-scoped payout figure either.

Asked Josh directly rather than guessing on a CFO-facing money tile. He confirmed: "amount we are
going to pay today" means **rent_requests funded today, not yet paid out to the landlord** — i.e.
today's new obligations specifically, not the overdue backlog. Verified live: only one
rent_request, UGX 4,000,000, was funded today (2026-09-18) with no completed `landlord_payouts` row
yet — a small, plausible number, since same-day funding is a small slice of the total float.

## What was fixed

- **`get_wallet_bucket_totals()`** (migration
  `20260918140000_wallet_bucket_totals_landlord_float_due_today.sql`, **written, not yet applied**):
  added `landlord_float_due_today_total` = `SUM(rent_requests.rent_amount)` where `funded_at` falls
  on today (Africa/Kampala) and no `landlord_payouts` row for that `rent_request_id` has
  `status = 'completed'` yet. `landlord_float_total` (the raw held-float figure) is **left
  unchanged** in the same response — it's the only field `get_merchant_payout_float`-adjacent code
  reads elsewhere, and nothing outside this one tile needed to change.
- **`WalletBucketsPanel.tsx`**: bucket #3's `totalKey` now points at
  `landlord_float_due_today_total` instead of `landlord_float_total`; description changed from
  "Money reserved for landlord payouts and funded tenants" to "Rent funded today, still owed to
  landlords."

**Until the migration is applied, the tile will still show the old ~80.3M total-held figure, not
the ~4M due-today figure.**

## What not to do

- Don't reuse `landlord_payouts.sla_deadline` for a "due today" figure — every pending payout is
  already overdue against it; it measures backlog age, not a same-day schedule.
- Don't change what `landlord_float_total` itself returns from `get_wallet_bucket_totals()` — it's
  a distinct, still-needed figure (the actual float balance sitting on agents), kept alongside the
  new due-today field rather than replaced. Clicking into the tile's per-agent drilldown
  (`WalletBucketHoldersPanel`, bucket `landlord_float`) still shows the full held balance per agent,
  intentionally left as-is — it answers "who's holding it," which is a different question from "what
  are we paying today."
- Don't assume "amount we're going to pay today" is self-evident from this schema — there is no
  payout-scheduling date field anywhere in `rent_requests` or `landlord_payouts`. This fix uses
  `funded_at = today` as the operational proxy Josh confirmed; if that proxy stops matching reality
  (e.g. agents start batching multi-day payouts), it will need to be re-asked, not re-guessed.

# 249 — The Weekly Collection Streak counted Rent Plans whose landlord was never paid (2026-10-24)

**Migration written, not applied (Josh applies by hand):**
`supabase/migrations/20261024100000_streak_ignores_plans_whose_landlord_is_unpaid.sql`
(rollback: the same name ending `.rollback.sql`). Read this before touching
`get_agent_weekly_collection_streak`, `_agent_week_active_days` or `process_weekly_streak_payouts`.

## What was reported

An agent (`5631cfe1-14b0-4ce2-9b9a-f7a808d3b12d`) received float for two tenants, Charles Mugenyi and Edward Kabanda,
could not pay their landlords, and was marked down for them. The tenants showed "OWING 552,000" in the agent app and
Friday 2026-10-23 read 17/19 (red) on the Weekly Collection Streak.

## What the database showed

- Both Rent Plans were funded 2026-10-22 08:33 UTC and are still `funded`: `disbursed_at` is null, `amount_repaid` 0.
- Both landlord payouts were refused by the 50% landlord-payout gate (23.8% over the last 7 days at the time, 27.2% on
  2026-10-24). Float allocations are `return_pending`, `paid_out_amount` 0. **Neither landlord was paid.**
- The 50% gate was NOT affected by these two. A plan bills (`pin_agent_expected_day`) only when `status = 'repaying'`, and the
  repaying gate (`gate_repaying_on_merchant_landlord_payout`) holds a plan at `funded` until the merchant payout lands. Neither
  tenant has a row in `agent_expected_day_plans`. The agent's 27.2% comes from the other 17 tenants.

## The fault

The streak ignores that rule. Both streak functions accept every `funded` plan as due from `repayment_starts_on`, which
`rent_request_default_repayment_start` defaults to funded_at + 1 day. A funded plan whose landlord was refused is therefore due
every day and cannot be collected. `process_weekly_streak_payouts` reads `_agent_week_active_days`, so each such day lowers the
weekly reward (7/7 = 50,000, 6 = 30,000, 5 = 20,000, 4 = 10,000).

## The fix

A `funded` plan counts toward the streak only when it passes the same test as the repaying gate:
`registration_type = 'outstanding_balance'`, or funded before the gate cutover `2026-09-24 06:22:48 UTC`, or
`rent_request_landlord_paid_by_merchant(id)`. `repaying` and `completed` plans are unchanged. Nothing else is touched: no
Rent Plan, collection, expected-day row, or reward already credited. Neither function is in `critical_function_baselines`.

## How far it reaches (measured 2026-10-24, before applying)

Only a handful of agents: it rescues 3 agents on Friday, 2 on Thursday, 1 each on Tuesday and Wednesday, 0 on Monday.
19 post-cutover plans platform-wide are `funded` with an unpaid landlord. 49 of the 69 `funded` plans are pre-cutover and
keep counting.

## It is not why most agents show a missed day

On Friday 105 of 118 agents missed (13 perfect; 77 collected nothing). Collection volume was normal (231 collections, 41 agents,
UGX 3.06M, against 190 to 335 a day earlier in the week). The streak needs EVERY due tenant paid each day, and the unpaid due
rows were: 510 `repaying` past the end of the term, 186 `repaying` in term, 45 `funded` past term, 19 `funded` in term with an
unpaid landlord (this fix), 1 `completed`.

**Josh decided 2026-10-24 that overdue past-term plans SHOULD count toward the streak.** So that is policy, not a bug. Do not
exclude them without a new decision.

## Left alone

- The agent's 50% landlord-payout block. Lifting it needs a row in `landlord_float_withdrawal_exceptions` for the week.
- The two tenants' float is already `return_pending`, so an exception now would not pay the landlords.
- "OWING 552,000" on the agent's tenant list is display of an unpaid, unstarted plan. UI change, not made.
- Whether a `funded`, landlord-unpaid plan should show as owing or have its repayment clock held is open.

## Verify after applying

As the agent, call `get_agent_weekly_collection_streak`. Friday should read 17/17 and `active`, and `best_possible_active`
should return from 6 to 7.

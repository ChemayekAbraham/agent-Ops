# Why 22 agents had no collection target for today (2026-09-17)

## Summary

The midnight job did run, on time, and succeeded. It was not a scheduling,
permission or failure problem. The 22 agents had **no target** because the
pinned bill only knows about days that fall *inside* a rent plan's agreed term.
Every one of those agents' plans had already passed its end date while still
owing money, so the bill for today was legitimately empty — expected UGX 0,
coverage 0%, and the 50% posting gate locked them out with the nonsense line
"Collect UGX 0 more today to unlock new rents".

## Evidence

Cron job `pin-agent-expected-day-eat-midnight` (jobid 18933):

- schedule `5 21 * * *` UTC = **00:05 Africa/Kampala** — correct
- last 7 nights (10–16 Sep): every run `succeeded`, `1 row` returned, all
  starting within 110 ms of 21:05:00 UTC

So the pin function was called on time each night and returned normally. It
simply had nothing to insert for those agents.

Where the emptiness comes from:

1. `pin_agent_expected_day(day)` sources rows from
   `rent_plan_schedule_days(day, day)` joined to `v_rent_plan_schedule`.
   The schedule generator only emits instalment days between a plan's
   `repayment_starts_on` and `repayment_starts_on + duration_days - 1`.
   A plan whose term has expired produces **no row for today**, even when the
   tenant still owes the balance.
2. Live count at time of writing: **417 plans past their term end and still
   owing**, spread over **48 agents**, with term ends going back to
   **2026-04-10**. For 22 agents, *all* of their active plans were in that
   state — hence a target of exactly zero.
3. Second, smaller defect: the old function began with an early return —
   if *any* row already existed for the day it did nothing and returned 0.
   So a plan that became billable after 00:05 (funded during the day, term or
   schedule corrected during the day) could never be picked up until the next
   night, and re-running the pin to repair a day was impossible.

Consequence in the gate: `enforce_agent_daily_eligibility()` blocks whenever
`active_count > 0` and best coverage `< 50%`. With expected = 0 the coverage is
0 by construction, so real collections did not count at all —
Nabateregga Brenda had taken UGX 40,000 and Arnold Oscar UGX 79,400 today, and
both still scored 0%.

## Fix applied

Migration `0149_pin_expected_day_topup_and_past_term_fallback`:

- The pin function no longer early-returns; it always tops up the day
  (`ON CONFLICT (day, rent_request_id) DO NOTHING`), so intra-day additions and
  repair re-runs work.
- Added a **past-term fallback**, scoped strictly to agents with *no* scheduled
  row for that day: their still-owing, past-term, non-weekly, paying plans are
  pinned at `LEAST(daily_repayment, outstanding)`. Agents who already have a
  scheduled bill for the day are untouched, so nobody else's expected figure or
  eligibility changed.
- Re-ran the pin for today: 197 additional rows (473 total).

Result for the previously-zero agents:

| Agent | Active | Expected today | Collected today | Best % |
|---|---|---|---|---|
| Akampurira Onesmus | 34 | 738,776 | 0 | 0.0 |
| Nabateregga Brenda Nakalema | 28 | 463,893 | 40,000 | 8.6 |
| Arnold Oscar | 14 | 456,922 | 79,400 | 17.4 |
| Denis Tushabe | 11 | 177,302 | 25,000 | 14.1 |

The 50% rule itself was not changed, so no posting loophole was opened.
Agents measured with a real target rose from 63 to 84; blocked agents rose from
24 to 44, which is the honest consequence of measuring agents who were
previously unmeasurable.

## Suggestions

1. **Add a nightly self-check, not just a cron.** Assert after each pin that no
   agent has `active_count > 0 AND expected_daily = 0`; raise a finance/ops alert
   row when one does. Today's failure was silent for months precisely because a
   succeeding cron looked like a healthy cron.
2. **Decide the policy for expired terms explicitly.** The fallback treats an
   overdue plan as owing its old daily instalment indefinitely. That is a
   reasonable default, but the business may prefer a formal *arrears plan*:
   re-scheduled term, an agreed daily figure, and a status distinct from
   `repaying`. Right now "past term but still owing" has no first-class
   representation anywhere.
3. **Never let a zero denominator mean 0%.** In the gate and the card, an
   unknown target should read "target not set" and be escalated, never scored as
   a failed 0%. Consider a guard in `enforce_agent_daily_eligibility()` that
   raises a distinct message when `expected_daily = 0` with active plans.
4. **Backfill history if reporting depends on it.** Past days (back to April)
   still have no pinned rows for these plans, so historical coverage,
   eligibility snapshots and Fleet/Agent Ops reports understate expected for
   those agents. A dated re-pin over a chosen window is now possible with the
   top-up behaviour — but it will change published historical percentages, so it
   needs a decision before running.
5. **Watch the newly-blocked agents.** 20 agents moved from "unmeasured" to
   "blocked". They are genuinely below 50%, but the sudden change should be
   communicated to Agent Ops rather than discovered by agents at the counter.

# 248 — Agents read "UGX 0 collected" while the arrears book went unbilled (2026-10-19)

Two independent faults met on the agent's capacity card. Both are fixed. Read this
before touching `v_agent_daily_eligibility`, `pin_agent_expected_day`, or
`useAgentCapacityMap`.

## 1. Every agent was locked out of their own figures

`get_agent_daily_eligibility` carried a staff-only gate:

```sql
if not (pg_trigger_depth() > 0 or public.can_view_staff_reports(auth.uid())) then
  raise exception 'not authorized' using errcode = '42501';
```

`can_view_staff_reports` asks "is this person staff". An agent is not. The function's
primary consumer is the agent's own capacity card, so **every ordinary agent got 42501**
— with a perfectly valid session. The gate was never in `supabase/migrations/`; it came
from a security-advisor sweep applied straight to production (114 functions carry it).

The damage was not a blank card. `useAgentCapacityMap` substituted client-side target
math for the **denominator** on failure, while every numerator and percentage kept
reading from the absent server row and stayed `0`. So the failure rendered as
*"UGX 0 of UGX 550,012 · 0% · Very Bad"* and set `can_post_rent_today = false`. One agent
had collected 255,000 against a 550,012 book and was blocked by his own app from posting
new Rent Plans — while the database trigger, which reaches the real numbers through its
`pg_trigger_depth()` escape, would have accepted them.

Fixed by `20261019120000` (self-scope escape: `p_agent_ids <@ array[auth.uid()]`) and by
removing the asymmetric fallback from the hook. **A failed read must never render as a
judgement.** If the server row is missing there is no denominator, no gate population,
and posting fails open.

## 2. The arrears book was never billed

`pin_agent_expected_day` bills in two passes: in-term plans off the schedule, then a
fallback for plans past their term end that still owe. The fallback only fired for agents
who got **nothing** from pass 1:

```sql
and not exists (select 1 from agents_with_bill a
                where a.agent_id = coalesce(rr.assigned_agent_id, rr.agent_id))
```

Every agent carrying overdue tenants also carries an in-term plan, so in practice the
fallback never ran for them: **356 repaying plans worth UGX 6,863,451/day across 44
agents had no line on any bill.** Agents collecting from those tenants moved nothing on
their figures. Fixed by `20261019104000`.

**That change is anchored to `agent_arrears_billing_go_live()` (2026-10-19) and the anchor
must stay.** `pin_agent_expected_day_catchup` re-pins the last 7 days every night
(lookback default 6); without the anchor, tonight's run retro-bills a week of
already-reported days.

A follow-on: the fallback did not honour `rent_repayment_pauses` (pass 1 always had). Its
first run put an absconded, paused tenant back on his agent's bill. Fixed by
`20261019130000`.

## What the numbers look like now

Arrears are the **majority** of the daily board — on 2026-10-19, UGX 10,329,756 against
7,361,429 in-term, and 32 of 109 agents have no in-term plans at all. Roughly a third of
everything agents collect (9.3M of 28.5M over 7 days) lands on expired plans.

**Do not "fix" this by basing expected on running plans only.** Two branches, both wrong:
drop expired from expected but keep the collections and coverage inflates by up to a third
(this is the bug fixed in September — 84% reported against a true 39.7%); drop both and a
third of the agents' real work vanishes, with those 32 all-expired agents reading 0 forever.
Worse, `expected_daily = 0` plus `past_cycle_owed > 0` forces `today_pct` to a hard 0, so
they would be permanently blocked with no way to earn their way out. If the money counts,
the bill counts.

The legibility problem is solved by splitting the **display**, not the basis:
`agent_expected_split(p_agent_ids, p_day)` (`20261019140000`) returns today's expected per
agent as in-term vs arrears. It takes an array and returns a row per id — pass the whole
set in one call, never one call per list row.

## Traps

- `CREATE OR REPLACE VIEW` does **not** carry reloptions. Rewriting
  `v_agent_daily_eligibility` silently dropped `security_invoker=on`; always re-apply it
  (see `20261019110000`).
- The read-time `status = 'repaying'` filter that used to sit in the view's `expected` CTE
  re-opened the pin: a plan leaving `repaying` mid-day left the denominator while its
  payment stayed in the numerator. The pin already bills only repaying plans. Let the pin
  be the pin.
- `rent_arrears_go_live()` (2026-09-10) and `agent_arrears_billing_go_live()` (2026-10-19)
  are different floors. Do not collapse them.

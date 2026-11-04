# 256 - Landlord payouts are graded through yesterday, never today (2026-11-03)

**Status: APPLIED TO PRODUCTION 2026-11-03 (Tuesday), Tuesday test passed. Thursday test (2026-11-05) still to run.**
Migration `20261103100001_payout_grade_through_yesterday.sql`; rollback `supabase/rollbacks/20261103100001_payout_grade_through_yesterday.rollback.sql`; test `supabase/tests/payout_grade_through_yesterday.sql`.

## The rule (Africa/Kampala; the rule week runs Thursday to Wednesday)
| Payout day | Graded on |
|---|---|
| Tuesday | Thursday through **Monday** (5 days). Tuesday itself is not counted. |
| Thursday | The week that just ended: previous Thursday through Wednesday (7 days). **Unchanged.** |
| Any other day | Thursday through **yesterday**. Today is never counted. |

## The bug
`public.agent_payout_weekly_performance(p_agent_id)` counted Thursday through **today** on every day except Thursday, so a Tuesday payout was graded on Tuesday's still-open collections. Proof on live data, Tuesday 3 Nov: the function's `expected` equalled the plan lines through Tuesday, not Monday.

## The change (three edits inside that one function, nothing else)
1. `DECLARE`: `v_through date := ((now() AT TIME ZONE 'Africa/Kampala')::date) - 1;`
2. `week_so_far` branch: `_agent_weekly_plan_lines(p_agent_id, v_cur, v_through)` (was `v_today`).
3. Reason label: `to_char(v_through, 'FMDD Mon')` (was `v_today`).

Unchanged: the Thursday branch, the targets in `agent_posting_rule_settings` (50% current plans; 50% current and 20% expired; 70% only expired), return columns, signature. `CREATE OR REPLACE` only, so grants are kept: `service_role` only (anon and authenticated cannot execute). A `COMMENT ON FUNCTION` states the rule.

## Blast radius (intended)
This function is the grade for 15 other functions: allow selected, allow with exception, reject, landlord float lock and gate, the CFO rent-disbursement gate, shortfall, and the rate lists the CTO/CFO screens read. They all move together.

## How it was applied
- Repo body copied from `origin/lovable` (`20261025120000_landlord_payout_allow_uses_weekly_money_rate.sql`; the local branch did not have it).
- Live body compared first: md5 of whitespace-normalised `prosrc` = `897a2af2fdc1b350103273683515d254` on both live and repo, so no drift.
- **Deviation from the brief:** it went straight to production, not staging, on Josh's explicit instruction. No staging database was reachable (the Lovable query tool returns `database_not_managed` after the PDPO cutover; applied through `supabase db query --linked`).
- After apply: grants verified (anon false, authenticated false, service_role true), new body present, comment present, test raised no error. The CLI does not print `NOTICE`, so the "N agents checked" line was not seen.

## Not changed, still different
**The agent's Weekly Performance page (`get_my_weekly_performance`) still counts through today.** On non-Thursdays it will show different numbers from the payout check. Not fixed here on purpose.

## Open
- Run `supabase/tests/payout_grade_through_yesterday.sql` on Thursday 2026-11-05 (basis must be `last_week`).
- Confirm the migration is recorded in `supabase_migrations` (it was run directly, not through the tracker; the file is idempotent).
- Not committed to `lovable`; Lovable has not been messaged.

## Rollback
Run the rollback file (restores the 20261025120000 body, grants re-asserted, comment cleared).

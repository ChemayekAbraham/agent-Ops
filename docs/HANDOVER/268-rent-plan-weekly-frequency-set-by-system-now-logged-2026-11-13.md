# 268 — A Rent Plan turned "weekly" by the system, with no record of who or what did it

**Date:** 2026-11-13 · **Asked by:** Josh (CTO) · **Status:** migration written and tested in a rolled-back transaction on production, **NOT APPLIED, NOT PUSHED.** The live function is unchanged (`prosecdef = false`, no `audit_logs` call).
**Migration:** `supabase/migrations/20261113090000_log_system_stamped_weekly_repayment_frequency.sql` · **Rollback:** `supabase/rollbacks/20261113090000_log_system_stamped_weekly_repayment_frequency.rollback.sql`

## What was asked

SHAKIRAH NAKIMBUGWE (+256770603906, `34ed279b-…`) told us her tenant Hamiss Mutyaba pays every day, but his Rent Plan `aba4e6e6-2b21-4a0a-8e03-fafcb012f6b8` is **weekly** (UGX 165,165 each Thursday, 23,595 × 7). We could not tell who set it. The CTO asked that every change be recorded with who made it.

## What was found

- The plan is a 35-day renewal. Trigger `tr_stamp_rent_request_repayment_frequency` (BEFORE INSERT on `rent_requests`, function `stamp_rent_request_repayment_frequency`) sets `repayment_frequency = 'weekly'` whenever `rent_request_is_weekly_shape(duration_days, registration_type)` is true: a duration that is a multiple of 7, other than 30/60/90/120, and a type other than `outstanding_balance`. It does this **even when the plan was submitted as daily**. So the weekly setting was probably the system's, not the agent's choice. (An earlier read in this thread said nothing downstream changes the value. That was wrong.)
- 1,813 plans are weekly in production (24 of them renewals). The same trigger probably explains many of them. They cannot be told apart from plans submitted as weekly, so there is no backfill.
- `ops_capture` already runs on `rent_requests` (config row in `ontology_capture`, enabled). It records the signed-in user, the old and new value of every changed column, and the time, into `ops_events`. It has only run since **4 Nov 2026 12:31 UTC**, so plans created before then have no creation record. It records the row *after* the trigger ran, so the submitted value was lost.
- Since 4 Nov, 71 plan creations are logged and 65 name a person. The other 6 are all **tenants applying for themselves** (`tenant_self_applied = true`) through the service role, so they log as "service". The tenant is identifiable from the row (`tenant_id`). No code change was needed for those 6; the new log names the tenant when this trigger fires for a self-applied plan.
- Stage events for this plan are `source = backfill` with no actor, so they say nothing about who submitted it.

## Fix

`stamp_rent_request_repayment_frequency` now writes one `audit_logs` row each time it overrides a submitted `daily` to `weekly`:

- `action_type = repayment_frequency_set_weekly_by_system`, `table_name = rent_requests`, `record_id` = the plan id
- `old_values` = the value as submitted (`daily`, or `null` when none was sent), `new_values` = `weekly`
- `reason` = the rule that fired, in plain words
- `user_id` = the signed-in user; for a tenant self-applied plan written by the service role, the tenant
- `metadata` = `actor_kind` (`person`, `tenant_self_applied_via_service` or `service`), duration, plan type, tenant, agent

Stamping itself is unchanged (same condition, same `repayment_starts_on` default). The audit insert sits in its own `BEGIN … EXCEPTION` block, so a logging failure only raises a WARNING and never blocks a submission. The function is now `SECURITY DEFINER` so an agent's session can write to the RLS-locked `audit_logs`; it is a trigger function, so no EXECUTE grant is added.

## Tested (production, one transaction that always rolls back, temp table with the same trigger)

| Case | Result |
| --- | --- |
| 35 days, renewal, submitted daily | weekly, one row, `actor_kind = service`, `old = daily` |
| 30 days, normal, daily | stays daily, no row |
| 28 days, submitted weekly | weekly, no row |
| 35 days, tenant self-applied, no frequency | weekly, one row, `actor_kind = tenant_self_applied_via_service`, user = tenant, `old = null` |
| 28 days, `outstanding_balance`, daily | stays daily, no row |

`repayment_starts_on` is stamped as before. After the test the live function was re-read: unchanged, zero leftover rows.

## Not changed

- No data on any existing plan. Hamiss's plan is still weekly. Changing it to daily would keep the same UGX 23,595 a day, so it would not fix his shortfall; that is a separate decision.
- Plans before 4 Nov stay without a creation record. Nothing can recreate it.
- No log of screen actions that change no row (picking an option, viewing a screen). That would be a separate client-side event log with volume and privacy cost.
- `critical_function_baselines` has no row for this function, so no re-baseline.
- Total repayment (717,371) does not equal 23,595 × 35 days (825,825) on this plan; not investigated.

## Verify after applying

```sql
select prosecdef, prosrc like '%repayment_frequency_set_weekly_by_system%' from pg_proc
 where proname = 'stamp_rent_request_repayment_frequency' and pronamespace = 'public'::regnamespace;  -- true, true
-- after the next 35-day (or any multiple-of-7) plan is submitted as daily:
select created_at, user_id, old_values, new_values, metadata->>'actor_kind', reason
  from audit_logs where action_type = 'repayment_frequency_set_weekly_by_system' order by created_at desc limit 5;
```

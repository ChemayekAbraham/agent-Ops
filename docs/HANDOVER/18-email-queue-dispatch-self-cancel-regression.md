# 18. Incident — `email_queue_dispatch` self-cancel, fixed then silently reverted (2026-09-14)

**Severity: Low functional impact (emails were never dropped), but a significant process finding.**
Fixed twice on the same day; the second fix is what motivated
[`17-critical-function-drift-detection.md`](./17-critical-function-drift-detection.md).

---

## The bug

`email_queue_dispatch()` is the command behind the `process-email-queue` cron job (armed by
`email_queue_wake()` on first enqueue). When it found both `pgmq` queues empty, it called

```sql
perform cron.unschedule('process-email-queue');
```

**from inside its own execution.** pg_cron cancels a job's active background worker the instant
its `cron.job` row is deleted — so the dispatcher cancelled itself, and pg_cron logged the run as
failed with `"job canceled"`. This surfaced in the 2026-09-12 CTO report as "(unscheduled)
email_queue_dispatch — 36 failures in 24h" and kept recurring. Cosmetic, not functional: the
cancellation only happens on the *empty-queue* branch, after any real work is already done — 0
emails failed, 100% notification delivery, the whole time.

## Fix #1 (2026-09-13, ~14:05 UTC)

Removed the self-disarm entirely. Once armed, `process-email-queue` just keeps polling every 5
seconds indefinitely — each empty-queue check costs ~4ms observed in `cron.job_run_details`, i.e.
~17k negligible checks/day. `email_queue_wake()` already re-arms the job if it were ever missing,
so dropping the disarm path is a pure behaviour subset. Applied directly to production, confirmed
0 cancellations in the following 5 minutes.

## It came back

By the time the 2026-09-13 CTO report ran (21:00 UTC), the live function body had the old
self-disarming branch back in it — confirmed by reading `pg_get_functiondef` directly, not
inferred from the report. **12 more cancellations** occurred between 14:20 and 21:30 UTC that day,
after fix #1 had already landed.

This did **not** come back through any migration file:

```bash
git log --oneline --all -S "cron.unschedule('process-email-queue')" -- supabase/migrations/
# only shows the 2026-04-13 original baseline and the fix commit itself
```

Something wrote the old function body straight to the database, outside the repo's migration
history entirely — consistent with the standing, documented condition that
`supabase/migrations/` does not faithfully reflect live production (see
[`07-tribal-knowledge.md`](./07-tribal-knowledge.md)).

## Fix #2 (2026-09-14)

Identical fix, re-applied directly to production. Verified live:

```sql
select pg_get_functiondef(oid) like '%cron.unschedule%' as still_broken
from pg_proc where proname = 'email_queue_dispatch'; -- expect false

select count(*) filter (where return_message = 'job canceled')
from cron.job_run_details
where command ilike '%email_queue_dispatch%' and start_time > now() - interval '1 hour';
-- expect 0
```

`email_queue_dispatch()` was then added to the drift-detection baseline
([`17-critical-function-drift-detection.md`](./17-critical-function-drift-detection.md)) so a
third silent revert triggers an alert within 15 minutes instead of waiting for the next day's CTO
report to notice.

---

## What not to do

- **Do not assume a CTO report showing "N failures today" for this job means it's currently
  broken right now.** The report reads a 24-hour historical window — check
  `cron.job_run_details` for the last hour directly (query above) for live state.
- **Do not assume a fix confirmed live earlier the same day is still live later that day.** This
  is the whole reason [`17-critical-function-drift-detection.md`](./17-critical-function-drift-detection.md)
  exists now — check it (`select * from critical_function_drift_alerts where
  function_signature = 'email_queue_dispatch()' and resolved_at is null`) before re-diagnosing
  from scratch.

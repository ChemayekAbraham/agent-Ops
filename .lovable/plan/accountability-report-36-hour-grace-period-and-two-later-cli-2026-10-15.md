# Accountability report: 36-hour grace period and two "Later" clicks

## What happens today
- The accountability popup appears as soon as the CFO approves a requisition. There is no waiting period.
- The requester can click "Later" up to 5 times, with a reason each time. The server enforces this limit.
- After a "Later", the popup comes back every 5 minutes.
- Nothing records when the popup was shown, or when the requester opened or dismissed it. Only deferrals and the final submission are saved.

## What will change
1. **36-hour grace period.** The first notice appears only once 36 hours have passed since the CFO approval time. The server works this out, so changing the device clock or refreshing the page has no effect.
2. **"Later" only twice.** The first and second notices allow "Later" with a reason. The third notice has no "Later" button. The requester must tick "I acknowledge" and then fill in the report. The server rejects a third deferral with: "Maximum deferrals reached. This accountability report can no longer be deferred."
3. **Clearer notice.** The popup and the enlarged CFO review queue show the requisition reference, the approval date, the deadline (approval + 36 hours) and the deferral count, for example "Deferred 1 of 2".
4. **Audit trail.** A new log that can only be added to records each event with the user and the time: notice shown, deferred (with reason), acknowledged, and report submitted. These events are also written to the audit log.
5. **Older requisitions.** Requisitions that already have 2 to 5 deferrals go straight to the mandatory notice. Nothing that is already recorded gets changed or deleted.

## Not touched
Permissions, approval routes, amounts, the ledger, wallets and money movement.

## Tests
These run inside a transaction that is rolled back afterwards:
- No notice at 35h59m, notice at 36h.
- First and second deferrals allowed, third refused.
- The third notice requires acknowledgement.
- The audit rows are written.
I will also check the popup in the preview.

## Technical details
- New server functions, available to the requester only:
  - `get_my_usage_report_notices()` returns the visible notices with `grace_ends_at = cfo_decided_at + 36h`, the deferral count, `mandatory` and the deadline.
  - `log_usage_report_notice_event(req_id, event)` records `shown` and `acknowledged` events.
- `defer_requisition_usage_report` checks the grace period and the new limit of 2.
- New append-only table `staff_requisition_usage_report_events`. A trigger on usage-report insert writes the `submitted` event.
- The popup reads the new function instead of filtering on the client.

## Approval needed
The database is shared with the live app, so applying the server change makes it live straight away. I will not apply it until you approve this plan.

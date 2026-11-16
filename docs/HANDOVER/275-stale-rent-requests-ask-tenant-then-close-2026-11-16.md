# 275 — Stale rent requests: ask the tenant, then close

**Date:** 2026-11-16 · **Asked by:** Josh (CTO) · **Status:** migration, rollback, edge function change and tenant UI on `dev/financial-ops`, tested in a rolled-back transaction on production. **NOT APPLIED, NOT DEPLOYED, NOT PUSHED, NO SMS SENT.**
**Migration:** `supabase/migrations/20261126090000_rent_request_reconfirm_stale_queue.sql` · **Rollback:** `supabase/rollbacks/20261126090000_rent_request_reconfirm_stale_queue.rollback.sql`

## What was found

- 3,799 rent requests sat in `pending` / `service_center_review`. Only 23 are live (sent in the last 30 days; 22 touched in 14 days). 3,776 had not been touched since August–October.
- 3,675 of those were created 15–19 Aug 2026, around the clock (about 1,000 a day), 2,158 with no agent, and were moved into `service_center_review` by a one-off backfill (`rent_request_stage_events.source = 'backfill'`) on the same days. Nobody opened them since. They look like real people who asked for rent and never heard back.
- The COO desk "Overdue vetting" counted all of them (3,777), so the 23 live ones were invisible. Owners come from `rent_requests.service_center_manager_id` through `service_center_vetting_items()`.
- In-app notifications of any type not on the allowlist in `block_all_notification_inserts()` are silently dropped.

## Decision (CTO, 16 Nov)

Ask first, then close: ask each tenant whether they still need rent, keep the ones who say yes, close the rest after 14 days with a plain message.

## Change

- `rent_request_reconfirmations` (one row per asked request: asked, reply-by date, confirmed, closed, outcome). RLS: the tenant reads their own row, ops roles read all, staff-MFA policy, grants as required.
- `start_rent_request_reconfirmation(p_apply default false, p_reply_days default 14)`: CTO, COO or super admin only. Stale = pending/review, sent 30+ days ago, nothing changed for 14+ days, not asked before. Requests the tenant has replaced with a newer one, or that sit beside a running Rent Plan, are closed (`cancelled`); the rest are asked with an in-app notification. Dry run returns counts and writes nothing. Running it again asks nobody twice.
- `confirm_rent_request_still_needed(id)`: the tenant's "Yes, I still need rent" (only their own, only while the request is still waiting).
- `close_unanswered_rent_request_reconfirmations()`: daily at 07:00 Kampala (cron `close-unanswered-rent-request-reconfirmations`); unanswered after the reply-by date → `cancelled` + "Rent request closed" notification.
- `service_center_vetting_items()`: requests waiting on the tenant no longer count as overdue; a confirmed request's clock starts at the confirmation. Landlord and LC1 branches unchanged. Not in `critical_function_baselines`.
- `block_all_notification_inserts()`: rebuilt from the live body with `rent_request_reconfirm` and `rent_request_reconfirm_closed` added.
- `broadcast-audience-sms`: new audience `rent_request_reconfirm` (tenants with an open question), through the existing dry run, test phone, block list and resumable `campaign_key`.
- Tenant app: the Rent Plan tab's progress card shows "Do you still need rent?" with the reply-by date and a "Yes, I still need rent" button; "cancelled" now reads "closed", not "withdrawn".

## Tested (production, one transaction that always rolls back)

| Check | Result |
| --- | --- |
| Dry run | 146 replaced by a newer request, 0 beside a running plan, 3,627 to ask; nothing written |
| Apply | 146 cancelled, 3,627 asked; a second apply asks 0 |
| COO desk queue (rent plans) | 3,777 → 4; one tenant confirms → 5, clock starts today |
| SMS audience | 3,627 |
| Confirm | own request: yes; twice: no; someone else's: no; non-staff starting it: refused |
| Daily job | closes 3,626 unanswered; the confirmed one stays in review |
| Notifications | the new types pass the allowlist; other types stay blocked |

UI: `RentRequestProgressCard.test.tsx` (4) and `rentRequestProgress.test.ts` (9) pass.

## To run it (each step needs the CTO's go-ahead)

1. Apply the migration, then deploy `broadcast-audience-sms`.
2. Publish the tenant app so the button exists before anyone is asked.
3. As CTO: `select * from start_rent_request_reconfirmation(false)` (counts), then `(true)`.
4. Check SMS credit, then send through the broadcast tool with audience `rent_request_reconfirm`, a `campaign_key`, a test phone first, then the dry run, then the send. About 3,627 messages.
5. After 14 days the daily job closes what is left.

## Not changed

Who owns live requests ("Unknown manager") and why the overdue alert is never shown are the next fix. Rollback does not reopen cancelled requests; the table records which ones.

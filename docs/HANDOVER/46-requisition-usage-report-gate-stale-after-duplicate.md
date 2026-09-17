# 46 — Requisition usage-report popup re-nags after a report already exists (2026-09-16)

**Status: fixed.** Before touching `RequisitionUsageReportGate.tsx`, or if a staff member reports
the "submit usage report" popup won't go away even though submitting fails with `duplicate key
value violates unique constraint "staff_requisition_usage_reports_req_uniq"`.

## The bug

`staff_requisition_usage_reports` has one report per requisition (`UNIQUE (requisition_id)`,
`0105_create_staff_requisition_usage_reports.sql`). Reported live for SRQ-00005: a report row
already existed (`a73ea677-e6e0-4263-a532-143e424e3eab`, submitted 2026-09-16 10:41:44 UTC,
"BOUGHT LOVABLE AI CREDITS", by the requisition's own requester) — so the duplicate-key rejection
on a second submit was Postgres working correctly. The actual bug was that the popup kept
reappearing for an already-reported requisition at all, and gave the user no way out.

Two gaps in `RequisitionUsageReportGate.tsx`'s `load()`/`submitReport()`:

1. **`load()`'s exclusion query dropped its error.** The query that finds which approved
   requisitions already have a report (`select requisition_id from
   staff_requisition_usage_reports where requisition_id in (...)`) never checked its own
   `error`. On any transient failure (RLS hiccup, cold start, network blip) `reports` comes back
   `undefined`, the exclusion `Set` is empty, and **every** approved requisition — including ones
   already reported — gets shown as still pending.
2. **A failed submit never resynced.** On any insert error (including the duplicate-key case),
   `submitReport()` just toasted an error and returned. It never called `load()`, so the stale
   `pending` array kept the already-reported requisition in it, and the 5-minute reminder
   `setInterval` just kept reopening the same stale modal indefinitely — with no way to make it
   stop, since dismissing only snoozes for 5 minutes and clicking submit always failed the same
   way.

## The fix

- `load()` now bails out (leaves `pending` as-is) instead of clearing the exclusion set when the
  reports query errors — never treats "couldn't check" as "nothing reported."
- `submitReport()` now detects a duplicate-key rejection (`error.code === '23505'` or a
  `duplicate key` message) as "this one's actually already done": shows a success-toned toast,
  closes the form, and calls `load()` to resync — which now correctly drops the requisition from
  `pending` since the report row genuinely exists.

## What not to do

- Don't add a unique-on-conflict `upsert` here instead — the one-report-per-requisition
  constraint is deliberate (finance reviews exactly one submitted report per requisition,
  `0107_usage_report_cfo_review.sql`'s `review_status` workflow assumes a single row). The fix is
  to stop re-showing something that's already satisfied, not to let it be overwritten.
- Don't assume this was a data problem — the report row was correct and complete. This was purely
  the popup's local state never re-syncing with the DB after the fact.

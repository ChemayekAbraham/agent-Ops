# Proposal: a minimal append-only recorder for rent request transitions (NOT applied; needs approval)

## Why

Verified on the deployed database (2026-10-19): an ordinary desk approval is recorded only as the latest `*_reviewed_at` stamp on `rent_requests` (a later re-approval overwrites it), and the `trigger_log_rent_request_event` trigger writes only `rent_request_created` and the legacy `approved` / `funded` / `disbursed` statuses to `system_events`. Returns, resubmissions, Service Centre decisions, force approvals and agent withdrawals are logged; CFO returns, recalls, reopens and skips are not. So the timing functions can label those cases an estimate but cannot make them exact, and they never will for requests that went round a desk more than once. A request transition recorder fixes that for every future handover.

## What

One table, written by one trigger, in the same transaction as the status change:

```sql
CREATE TABLE public.rent_request_transitions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id    uuid        NOT NULL REFERENCES public.rent_requests(id) ON DELETE CASCADE,
  occurred_at   timestamptz NOT NULL DEFAULT clock_timestamp(),  -- server time, taken inside the status-change transaction
  from_status   text,
  to_status     text        NOT NULL,
  from_desk     text,        -- derived from the status with the same mapping as rent_request_timing; NULL for no desk
  to_desk       text,
  kind          text        NOT NULL,  -- insert | approval | return | correction | resubmit | recall | reopen | skip | terminal | funded
  actor_id      uuid,                  -- auth.uid() at the time; NULL for system
  reason_code   text,                  -- copied from the existing reason / stage columns, never parsed from free text
  UNIQUE (request_id, occurred_at, to_status)
);
CREATE INDEX rent_request_transitions_request_idx ON public.rent_request_transitions (request_id, occurred_at);
```

- Trigger `AFTER INSERT OR UPDATE OF status ON rent_requests` (a new trigger; no existing trigger or function is changed) inserts a row only when `status` changes (or on insert). `kind` is decided from OLD/NEW status only: forward move = approval (a jump over a desk = skip), move to `rejected` with `returned_at` just set = return, `rejected` back to a desk = resubmit/reopen, a move to an earlier desk from a later one = recall, `deleted_by_agent` / `cancelled` / `rejected` without a return = terminal. It does not change any decision and cannot block a transition (it never raises).
- Append-only: `REVOKE UPDATE, DELETE, TRUNCATE`; a `BEFORE UPDATE OR DELETE` trigger that raises; SELECT only through a SECURITY DEFINER reader or the same visibility as `rent_requests`. Old audit and system-event rows are never touched.
- System-event and audit conventions are kept: the existing `log_system_event` / audit writes are not replaced, only left as they are; the recorder does not invent a trust-score formula.
- No backfill and no fabrication: existing requests keep what the stamps and events say (labelled estimates). Rows start from the day it is applied. `rent_request_timing` would then prefer `rent_request_transitions` when a request has rows after the apply date and fall back to the current evidence for older requests.
- Cost: one small insert per status change (a few hundred a day); one index; no polling; retention: keep (the table is small).

## Approval needed before applying

This adds a table and a trigger on `rent_requests`. It has not been created. Nothing in this repo applies it.

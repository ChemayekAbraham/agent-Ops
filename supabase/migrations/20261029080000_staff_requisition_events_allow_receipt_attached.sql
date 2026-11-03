-- staff-requisition-add-attachment logs action 'receipt_attached' after a receipt is stored and attached to a
-- requisition; the value was not in the check list, so that audit event was refused (3 refusals 10-28 15:15 to 10-29
-- 06:46). The receipt itself was saved correctly; only the history row was lost. Superset of the old list.
-- Applied to production by hand; this file is the record.
alter table public.staff_requisition_events
  drop constraint if exists staff_requisition_events_action_check,
  add constraint staff_requisition_events_action_check
    check (action = any (array[
      'created', 'approved', 'rejected', 'returned', 'resubmitted', 'credited',
      'credit_failed', 'comment', 'amount_reduced', 'rerouted', 'receipt_attached'
    ]::text[]));

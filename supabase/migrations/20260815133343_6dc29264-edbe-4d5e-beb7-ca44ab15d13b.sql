ALTER TABLE public.budget_submission_events DROP CONSTRAINT IF EXISTS budget_submission_events_event_type_check;
ALTER TABLE public.budget_submission_events ADD CONSTRAINT budget_submission_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'submitted','returned','approved','release_previewed','released','paid','cancelled',
    'created','updated','line_insert','line_update','line_delete',
    'status_draft','status_submitted','status_under_review','status_revision_requested',
    'status_approved','status_rejected','status_superseded','status_returned',
    'status_released','status_paid','status_cancelled'
  ]));
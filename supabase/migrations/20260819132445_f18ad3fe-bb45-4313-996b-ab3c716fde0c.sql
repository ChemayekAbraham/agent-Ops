REVOKE DELETE, MAINTAIN ON TABLE public.hr_tickets FROM authenticated;
REVOKE DELETE, MAINTAIN ON TABLE public.hr_ticket_surfaces FROM authenticated;
REVOKE DELETE, MAINTAIN ON TABLE public.hr_review_weeks FROM authenticated;

ALTER TABLE public.hr_task_events
  ADD CONSTRAINT hr_task_events_completed_needs_note
  CHECK (event_type <> 'completed'::hr_task_event_type OR length(btrim(coalesce(note, ''))) >= 10)
  NOT VALID;
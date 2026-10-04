ALTER TABLE public.recruiter_override_events
  ADD COLUMN IF NOT EXISTS ledger_group_id uuid;
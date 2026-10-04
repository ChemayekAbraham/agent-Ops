ALTER TABLE public.agent_advance_requests
  ADD COLUMN IF NOT EXISTS cfo_approved_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS cfo_approved_at timestamp with time zone;
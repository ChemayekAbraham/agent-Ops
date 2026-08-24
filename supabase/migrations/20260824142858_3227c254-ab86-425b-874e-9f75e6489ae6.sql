ALTER TABLE public.hr_job_postings
  ADD COLUMN closed_at timestamptz NULL,
  ADD COLUMN closed_by uuid NULL;
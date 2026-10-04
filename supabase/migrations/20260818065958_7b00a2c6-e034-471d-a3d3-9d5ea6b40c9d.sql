BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.job_applications DROP CONSTRAINT IF EXISTS job_applications_status_check;
ALTER TABLE public.job_applications
  ADD CONSTRAINT job_applications_status_check
  CHECK (
    status IS NOT NULL
    AND status IN (
      'new',
      'contacted',
      'interviewing',
      'shortlisted',
      'hold',
      'hired',
      'rejected'
    )
  );
COMMIT;
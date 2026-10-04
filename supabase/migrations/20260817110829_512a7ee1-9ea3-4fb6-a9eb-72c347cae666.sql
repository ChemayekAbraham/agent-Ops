BEGIN;

CREATE TABLE IF NOT EXISTS public.hr_job_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  department_id uuid REFERENCES public.hr_departments(id) ON DELETE SET NULL,
  summary text,
  description text,
  responsibilities text,
  requirements text,
  location text,
  employment_type text NOT NULL DEFAULT 'full_time',
  status text NOT NULL DEFAULT 'draft',
  public_slug text UNIQUE,
  closed_message text,
  opens_at timestamptz,
  closes_at timestamptz,
  published_at timestamptz,
  created_by uuid,
  updated_by uuid,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.hr_job_postings
  ADD CONSTRAINT hr_job_postings_status_check
  CHECK (status IN ('draft','open','closed','archived'));

ALTER TABLE public.hr_job_postings
  ADD CONSTRAINT hr_job_postings_employment_check
  CHECK (employment_type IN ('full_time','part_time','contract','internship','commission'));

GRANT SELECT ON public.hr_job_postings TO anon;
GRANT SELECT, INSERT, UPDATE ON public.hr_job_postings TO authenticated;
GRANT ALL ON public.hr_job_postings TO service_role;

ALTER TABLE public.hr_job_postings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Published postings readable by anyone"
  ON public.hr_job_postings
  FOR SELECT
  USING (status IN ('open','closed'));

CREATE POLICY "HR reads every posting"
  ON public.hr_job_postings
  FOR SELECT
  TO authenticated
  USING (public.hr_is_admin());

CREATE POLICY "HR writes postings"
  ON public.hr_job_postings
  FOR INSERT
  TO authenticated
  WITH CHECK (public.hr_is_admin());

CREATE POLICY "HR updates postings"
  ON public.hr_job_postings
  FOR UPDATE
  TO authenticated
  USING (public.hr_is_admin())
  WITH CHECK (public.hr_is_admin());

INSERT INTO public.hr_job_postings (title, department_id, summary, location, employment_type, status, public_slug, closed_message)
VALUES (
  'Platform Sales Officer',
  NULL,
  'Drive tenant and landlord acquisition for the Welile platform across assigned regions.',
  'Kampala, Uganda',
  'commission',
  'open',
  'sales',
  'Applications for this role are currently closed. Please check back soon.'
);

COMMIT;
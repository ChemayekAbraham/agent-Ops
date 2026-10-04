BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.internship_applications
  ADD COLUMN IF NOT EXISTS institution                text,
  ADD COLUMN IF NOT EXISTS course                     text,
  ADD COLUMN IF NOT EXISTS year_of_study              smallint,
  ADD COLUMN IF NOT EXISTS expected_completion        date,
  ADD COLUMN IF NOT EXISTS availability_start         date,
  ADD COLUMN IF NOT EXISTS availability_weeks         smallint,
  ADD COLUMN IF NOT EXISTS availability_days_per_week smallint,
  ADD COLUMN IF NOT EXISTS preferred_contact_channel  text,
  ADD COLUMN IF NOT EXISTS cohort                     text,
  ADD COLUMN IF NOT EXISTS linked_user_id             uuid,
  ADD COLUMN IF NOT EXISTS enrolled_staff_id          uuid,
  ADD COLUMN IF NOT EXISTS enrolled_at                timestamptz;

ALTER TABLE public.internship_applications
  ADD CONSTRAINT internship_applications_status_check
  CHECK (status IS NULL OR status IN (
    'new','screening','interviewing','offered','placed',
    'declined','not_selected','retained','withdrawn'
  ));

ALTER TABLE public.internship_applications
  ADD CONSTRAINT internship_applications_contact_channel_check
  CHECK (preferred_contact_channel IS NULL
         OR preferred_contact_channel IN ('phone','whatsapp','email'));

ALTER TABLE public.internship_applications
  ADD CONSTRAINT internship_applications_weeks_check
  CHECK (availability_weeks IS NULL
         OR (availability_weeks >= 1 AND availability_weeks <= 52));

ALTER TABLE public.internship_applications
  ADD CONSTRAINT internship_applications_days_check
  CHECK (availability_days_per_week IS NULL
         OR (availability_days_per_week >= 1 AND availability_days_per_week <= 7));

ALTER TABLE public.internship_applications
  ADD CONSTRAINT internship_applications_year_check
  CHECK (year_of_study IS NULL
         OR (year_of_study >= 1 AND year_of_study <= 8));

INSERT INTO public.hr_departments (key, name, measurement_mode, active)
SELECT 'interns', 'Interns', 'mixed'::hr_measurement_mode, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.hr_departments WHERE key = 'interns'
);

INSERT INTO public.hr_positions (key, title, department_id, active, org_wide_read)
SELECT 'intern',
       'Intern',
       (SELECT id FROM public.hr_departments WHERE key = 'interns'),
       true,
       false
WHERE NOT EXISTS (
  SELECT 1 FROM public.hr_positions WHERE key = 'intern'
);

GRANT INSERT (
  full_name,
  phone,
  email,
  motivation,
  skills,
  ready_to_learn,
  referral_code,
  consent_text_version,
  consented_at,
  future_roles_consent,
  institution,
  course,
  year_of_study,
  expected_completion,
  availability_start,
  availability_weeks,
  availability_days_per_week,
  preferred_contact_channel
) ON public.internship_applications TO anon;

COMMIT;
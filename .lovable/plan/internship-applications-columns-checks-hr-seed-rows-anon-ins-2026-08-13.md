# Internship applications: columns, checks, HR seed rows, anon insert grant

Verified current state (read-only):

- `internship_applications` already has 32 columns and all five CHECK constraints (`status`, `contact_channel`, `weeks`, `days`, `year`).
- `hr_departments` = 10 rows, `hr_positions` = 19 rows, `status = 'retained'` = 30 rows.
- `anon` currently holds **no** privileges on `internship_applications` — table-level or column-level. This is the only part still missing.

Everything below is written to be a no-op where already applied, per the scope fence.

## SQL to run (one transaction)

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';

-- A. Columns (nullable, no defaults, no FKs)
ALTER TABLE public.internship_applications ADD COLUMN IF NOT EXISTS institution text;
ALTER TABLE public.internship_applications ADD COLUMN IF NOT EXISTS course text;
ALTER TABLE public.internship_applications ADD COLUMN IF NOT EXISTS year_of_study smallint;
ALTER TABLE public.internship_applications ADD COLUMN IF NOT EXISTS expected_completion date;
ALTER TABLE public.internship_applications ADD COLUMN IF NOT EXISTS availability_start date;
ALTER TABLE public.internship_applications ADD COLUMN IF NOT EXISTS availability_weeks smallint;
ALTER TABLE public.internship_applications ADD COLUMN IF NOT EXISTS availability_days_per_week smallint;
ALTER TABLE public.internship_applications ADD COLUMN IF NOT EXISTS preferred_contact_channel text;
ALTER TABLE public.internship_applications ADD COLUMN IF NOT EXISTS cohort text;
ALTER TABLE public.internship_applications ADD COLUMN IF NOT EXISTS linked_user_id uuid;
ALTER TABLE public.internship_applications ADD COLUMN IF NOT EXISTS enrolled_staff_id uuid;
ALTER TABLE public.internship_applications ADD COLUMN IF NOT EXISTS enrolled_at timestamptz;

-- B. CHECK constraints (drop-if-exists then add; all null-tolerant)
ALTER TABLE public.internship_applications DROP CONSTRAINT IF EXISTS internship_applications_status_check;
ALTER TABLE public.internship_applications ADD CONSTRAINT internship_applications_status_check
  CHECK (status IS NULL OR status IN ('new','screening','interviewing','offered','placed','declined','not_selected','retained','withdrawn'));

ALTER TABLE public.internship_applications DROP CONSTRAINT IF EXISTS internship_applications_contact_channel_check;
ALTER TABLE public.internship_applications ADD CONSTRAINT internship_applications_contact_channel_check
  CHECK (preferred_contact_channel IS NULL OR preferred_contact_channel IN ('phone','whatsapp','email'));

ALTER TABLE public.internship_applications DROP CONSTRAINT IF EXISTS internship_applications_weeks_check;
ALTER TABLE public.internship_applications ADD CONSTRAINT internship_applications_weeks_check
  CHECK (availability_weeks IS NULL OR (availability_weeks BETWEEN 1 AND 52));

ALTER TABLE public.internship_applications DROP CONSTRAINT IF EXISTS internship_applications_days_check;
ALTER TABLE public.internship_applications ADD CONSTRAINT internship_applications_days_check
  CHECK (availability_days_per_week IS NULL OR (availability_days_per_week BETWEEN 1 AND 7));

ALTER TABLE public.internship_applications DROP CONSTRAINT IF EXISTS internship_applications_year_check;
ALTER TABLE public.internship_applications ADD CONSTRAINT internship_applications_year_check
  CHECK (year_of_study IS NULL OR (year_of_study BETWEEN 1 AND 8));

-- C. Interns department
INSERT INTO public.hr_departments (key, name, measurement_mode, active)
SELECT 'interns', 'Interns', 'mixed'::hr_measurement_mode, true
WHERE NOT EXISTS (SELECT 1 FROM public.hr_departments WHERE key = 'interns');

-- D. Intern position
INSERT INTO public.hr_positions (key, title, active, org_wide_read, department_id)
SELECT 'intern', 'Intern', true, false,
       (SELECT id FROM public.hr_departments WHERE key = 'interns' LIMIT 1)
WHERE NOT EXISTS (SELECT 1 FROM public.hr_positions WHERE key = 'intern');

-- E. Column-level INSERT grant for anon (exactly 18 columns, no table-level grant)
GRANT INSERT (
  full_name, phone, email, motivation, skills, ready_to_learn,
  referral_code, consent_text_version, consented_at,
  future_roles_consent, institution, course, year_of_study,
  expected_completion, availability_start, availability_weeks,
  availability_days_per_week, preferred_contact_channel
) ON public.internship_applications TO anon;

COMMIT;
```

## After it runs

I will report the nine verification lines you asked for (migration filename, files changed, column count, anon insert column count, anon table-level privileges, department/position row counts, the five constraint names, and the retained-row count).
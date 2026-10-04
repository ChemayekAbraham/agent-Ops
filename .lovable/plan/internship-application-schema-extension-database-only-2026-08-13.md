# Internship application schema extension (database only)

One transaction against project `wirntoujqoyjobfhyelc`. No application files, no existing migration files, no policy changes, and no `hr_pay_*` / `hr_task*` / `job_applications` tables touched.

## Verified current state

- `public.internship_applications` has 20 columns today; the 12 new ones bring it to 32.
- Its only constraint today is the primary key — none of the five named constraints exist yet.
- All 30 rows have `status = 'retained'`, which is inside the proposed status allowlist, so the status check adds cleanly.
- `anon` currently holds no privileges (table-level or column-level) on `internship_applications`, so the grant is issued fresh and column-scoped only.
- `hr_departments` has 9 rows and no row with key `interns`; `hr_positions` has 18 rows and no row with key `intern`. Adding one each gives 10 and 19.
- `hr_positions.department_id` is a nullable `uuid`, so the id can be derived by subquery with no foreign key added.

## SQL to run

```sql
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
```

## Notes on specific choices

- Every check is written `... IS NULL OR ...` so existing and future NULLs pass, including the status check.
- The department insert casts `'mixed'` to `hr_measurement_mode`, which is what that column's type requires.
- No table-level `GRANT INSERT` is issued, and none of `status`, `cohort`, `linked_user_id`, `enrolled_staff_id`, `enrolled_at`, `contacted_by`, `contacted_at`, `decided_at`, `decided_by`, `decision_reason`, `purged_at`, `updated_at`, `id`, `created_at` appears in the grant.

## Verification reported after the run

1. migration file created (filename)
2. application files changed (expect 0)
3. column count on `internship_applications` (expect 32)
4. columns `anon` holds INSERT on (expect 18)
5. `hr_departments` row count (expect 10)
6. `hr_positions` row count (expect 19)
7. `internship_applications` rows with `status = 'retained'` (expect 30)
8. the five step-B constraint names, confirmed present
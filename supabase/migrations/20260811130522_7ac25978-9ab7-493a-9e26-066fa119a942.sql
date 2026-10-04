BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.internship_applications
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS contacted_by uuid,
  ADD COLUMN IF NOT EXISTS contacted_at timestamptz,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS decided_by uuid,
  ADD COLUMN IF NOT EXISTS decision_reason text,
  ADD COLUMN IF NOT EXISTS purged_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_text_version text,
  ADD COLUMN IF NOT EXISTS consented_at timestamptz,
  ADD COLUMN IF NOT EXISTS future_roles_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP POLICY IF EXISTS "Anyone can submit internship application" ON public.internship_applications;
CREATE POLICY "Anyone can submit internship application"
  ON public.internship_applications FOR INSERT TO anon, authenticated
  WITH CHECK (
    status = 'new' AND contacted_by IS NULL AND contacted_at IS NULL
    AND decided_at IS NULL AND decided_by IS NULL
    AND decision_reason IS NULL AND purged_at IS NULL
  );

DROP POLICY IF EXISTS "HR can delete internship applications" ON public.internship_applications;
CREATE POLICY "HR can delete internship applications"
  ON public.internship_applications FOR DELETE TO authenticated
  USING (has_role(auth.uid(), 'hr'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

DROP POLICY IF EXISTS "HR can update internship applications" ON public.internship_applications;
CREATE POLICY "HR can update internship applications"
  ON public.internship_applications FOR UPDATE TO authenticated
  USING (has_role(auth.uid(), 'hr'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'hr'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

REVOKE INSERT ON public.internship_applications FROM anon;
GRANT INSERT (full_name, phone, email, motivation, skills, ready_to_learn, referral_code, consent_text_version, consented_at, future_roles_consent) ON public.internship_applications TO anon;

UPDATE public.internship_applications
   SET decided_at = '2026-08-11 00:00:00+00',
       status = 'retained',
       decision_reason = 'Reviewed 11 Aug 2026. Retained under the applicant retention decision of 30 July 2026. No opt-in on record, so the 12-month period applies from this date.'
 WHERE decided_at IS NULL;

COMMIT;
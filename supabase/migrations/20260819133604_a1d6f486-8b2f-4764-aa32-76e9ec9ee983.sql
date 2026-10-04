CREATE TABLE public.hr_task_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL UNIQUE REFERENCES public.hr_tasks(id),
  week_ending date NOT NULL REFERENCES public.hr_review_weeks(week_ending),
  difficulty_band hr_difficulty_band NOT NULL,
  quality hr_quality NOT NULL,
  basis text NOT NULL,
  assessed_by uuid NOT NULL REFERENCES public.hr_staff(id),
  assessed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_task_assessments_basis_length CHECK (length(btrim(basis)) >= 10)
);

ALTER TABLE public.hr_task_assessments ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON public.hr_task_assessments TO authenticated;
REVOKE DELETE, MAINTAIN, TRUNCATE, REFERENCES, TRIGGER ON public.hr_task_assessments FROM authenticated;
REVOKE ALL ON public.hr_task_assessments FROM anon;

DROP POLICY IF EXISTS hr_task_assessments_select_own ON public.hr_task_assessments;
CREATE POLICY hr_task_assessments_select_own
  ON public.hr_task_assessments
  FOR SELECT
  USING (task_id IN (SELECT id FROM public.hr_tasks WHERE assignee_staff_id = public.hr_my_staff_id()));

DROP POLICY IF EXISTS hr_task_assessments_select_assigners ON public.hr_task_assessments;
CREATE POLICY hr_task_assessments_select_assigners
  ON public.hr_task_assessments
  FOR SELECT
  USING (public.hr_can_assign_tasks());

DROP POLICY IF EXISTS hr_task_assessments_insert_reviewer ON public.hr_task_assessments;
CREATE POLICY hr_task_assessments_insert_reviewer
  ON public.hr_task_assessments
  FOR INSERT
  WITH CHECK (public.hr_can_assign_tasks() AND assessed_by = public.hr_my_staff_id());

CREATE OR REPLACE FUNCTION public.hr_assessment_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_assignee uuid;
  v_status hr_task_status;
  v_locked_at timestamptz;
BEGIN
  SELECT assignee_staff_id, status INTO v_assignee, v_status
  FROM public.hr_tasks WHERE id = NEW.task_id;

  IF v_assignee IS NOT NULL AND v_assignee = NEW.assessed_by THEN
    RAISE EXCEPTION 'An engineer cannot assess their own task';
  END IF;

  IF v_status IS DISTINCT FROM 'completed'::hr_task_status THEN
    RAISE EXCEPTION 'Only a completed task can be assessed';
  END IF;

  SELECT locked_at INTO v_locked_at
  FROM public.hr_review_weeks WHERE week_ending = NEW.week_ending;

  IF v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'The review week is locked';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER hr_task_assessments_guard
  BEFORE INSERT ON public.hr_task_assessments
  FOR EACH ROW
  EXECUTE FUNCTION public.hr_assessment_guard();

INSERT INTO public.hr_review_weeks (week_ending)
VALUES ('2026-08-21'), ('2026-08-28'), ('2026-09-04'), ('2026-09-11')
ON CONFLICT DO NOTHING;
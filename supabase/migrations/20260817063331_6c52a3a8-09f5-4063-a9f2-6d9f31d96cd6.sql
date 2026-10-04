BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user_roles' AND column_name='enabled'
  ) THEN
    RAISE EXCEPTION 'wrong database';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.hr_metric_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_kind text NOT NULL,
  department_id uuid NULL REFERENCES public.hr_departments(id),
  staff_id uuid NULL REFERENCES public.hr_staff(id),
  metric_key text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  target_value numeric NOT NULL,
  pace_model text NOT NULL DEFAULT 'working_days',
  base_metric_key text NULL,
  amber_lag_pct numeric NOT NULL DEFAULT 10,
  red_lag_pct numeric NOT NULL DEFAULT 25,
  source_task_id uuid NULL REFERENCES public.hr_tasks(id),
  status text NOT NULL DEFAULT 'provisional',
  note text NULL,
  set_by uuid NOT NULL DEFAULT auth.uid(),
  set_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz NULL,
  retired_by uuid NULL
);

GRANT SELECT, INSERT, UPDATE ON public.hr_metric_targets TO authenticated;
GRANT ALL ON public.hr_metric_targets TO service_role;

ALTER TABLE public.hr_metric_targets DROP CONSTRAINT IF EXISTS hr_metric_targets_scope_kind_chk;
ALTER TABLE public.hr_metric_targets ADD CONSTRAINT hr_metric_targets_scope_kind_chk
  CHECK (scope_kind IN ('department','staff'));

ALTER TABLE public.hr_metric_targets DROP CONSTRAINT IF EXISTS hr_metric_targets_pace_model_chk;
ALTER TABLE public.hr_metric_targets ADD CONSTRAINT hr_metric_targets_pace_model_chk
  CHECK (pace_model IN ('calendar','working_days','installed_base'));

ALTER TABLE public.hr_metric_targets DROP CONSTRAINT IF EXISTS hr_metric_targets_status_chk;
ALTER TABLE public.hr_metric_targets ADD CONSTRAINT hr_metric_targets_status_chk
  CHECK (status IN ('provisional','confirmed','retired'));

ALTER TABLE public.hr_metric_targets DROP CONSTRAINT IF EXISTS hr_metric_targets_scope_match_chk;
ALTER TABLE public.hr_metric_targets ADD CONSTRAINT hr_metric_targets_scope_match_chk
  CHECK (
    (scope_kind = 'department' AND department_id IS NOT NULL AND staff_id IS NULL)
    OR (scope_kind = 'staff' AND staff_id IS NOT NULL AND department_id IS NULL)
  );

ALTER TABLE public.hr_metric_targets DROP CONSTRAINT IF EXISTS hr_metric_targets_value_period_chk;
ALTER TABLE public.hr_metric_targets ADD CONSTRAINT hr_metric_targets_value_period_chk
  CHECK (target_value > 0 AND period_end >= period_start);

CREATE UNIQUE INDEX IF NOT EXISTS hr_metric_targets_active_scope_uidx
  ON public.hr_metric_targets (metric_key, period_start, coalesce(department_id, staff_id))
  WHERE retired_at IS NULL;

ALTER TABLE public.hr_metric_targets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hr_metric_targets_select" ON public.hr_metric_targets;
CREATE POLICY "hr_metric_targets_select" ON public.hr_metric_targets
FOR SELECT TO authenticated
USING (
  public.hr_is_admin()
  OR public.hr_is_executive()
  OR staff_id = public.hr_my_staff_id()
  OR (staff_id IS NOT NULL AND public.hr_manages(staff_id))
  OR (department_id IS NOT NULL AND department_id = (
        SELECT a.department_id FROM public.hr_assignments a
        WHERE a.staff_id = public.hr_my_staff_id() AND a.is_primary
        LIMIT 1
      ))
);

DROP POLICY IF EXISTS "hr_metric_targets_insert" ON public.hr_metric_targets;
CREATE POLICY "hr_metric_targets_insert" ON public.hr_metric_targets
FOR INSERT TO authenticated
WITH CHECK (public.hr_is_admin() OR public.hr_is_executive());

DROP POLICY IF EXISTS "hr_metric_targets_update" ON public.hr_metric_targets;
CREATE POLICY "hr_metric_targets_update" ON public.hr_metric_targets
FOR UPDATE TO authenticated
USING (public.hr_is_admin() OR public.hr_is_executive())
WITH CHECK (public.hr_is_admin() OR public.hr_is_executive());

CREATE OR REPLACE FUNCTION public.hr_working_days(_from date, _to date)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT count(*)::int
  FROM generate_series(_from, _to, interval '1 day') AS d
  WHERE extract(isodow FROM d) < 6
$$;

COMMENT ON FUNCTION public.hr_working_days(date, date) IS
  'Counts Mon-Fri days inclusive. Public holidays are deliberately not modelled.';

COMMENT ON TABLE public.hr_metric_targets IS
  'Replaces target-setting through partner_ops_targets.';

COMMENT ON COLUMN public.hr_metric_targets.status IS
  'provisional means the figure has not been confirmed by leadership.';

COMMIT;
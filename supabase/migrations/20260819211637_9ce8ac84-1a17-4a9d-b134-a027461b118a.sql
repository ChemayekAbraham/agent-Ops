CREATE TABLE IF NOT EXISTS public.budget_cycle_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES public.budget_calls(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES public.hr_departments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, department_id, user_id)
);

GRANT SELECT ON public.budget_cycle_notifications TO authenticated;
GRANT ALL ON public.budget_cycle_notifications TO service_role;

ALTER TABLE public.budget_cycle_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read their own budget cycle notices" ON public.budget_cycle_notifications;
CREATE POLICY "Users read their own budget cycle notices"
  ON public.budget_cycle_notifications FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR public.is_budget_reviewer((SELECT auth.uid())));

CREATE OR REPLACE FUNCTION public.budget_department_access_user_ids(_department_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT DISTINCT od.user_id
    FROM operations_departments od
    JOIN hr_departments d ON lower(d.key) = lower(od.department)
   WHERE d.id = _department_id AND d.active AND od.user_id IS NOT NULL;
$function$;

CREATE OR REPLACE FUNCTION public.budget_notify_cycle_open(_call_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_call budget_calls;
  v_sent int := 0;
  r record;
BEGIN
  SELECT * INTO v_call FROM budget_calls WHERE id = _call_id;
  IF v_call.id IS NULL OR v_call.status <> 'open' THEN RETURN 0; END IF;

  FOR r IN
    SELECT d.id AS department_id, d.name AS department_name, u.user_id
      FROM hr_departments d
      CROSS JOIN LATERAL public.budget_department_access_user_ids(d.id) AS u(user_id)
     WHERE d.active
       AND NOT EXISTS (
         SELECT 1 FROM budget_cycle_notifications n
          WHERE n.call_id = _call_id AND n.department_id = d.id AND n.user_id = u.user_id
       )
  LOOP
    INSERT INTO budget_cycle_notifications(call_id, department_id, user_id)
    VALUES (_call_id, r.department_id, r.user_id)
    ON CONFLICT (call_id, department_id, user_id) DO NOTHING;

    IF FOUND THEN
      PERFORM public.budget_notify(
        r.user_id,
        'Budget cycle open: ' || v_call.title,
        'The budget cycle "' || v_call.title || '" is open for ' || r.department_name || '. '
          || CASE WHEN v_call.deadline IS NOT NULL
                  THEN 'Submit your departmental budget by ' || to_char(v_call.deadline AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY HH24:MI') || ' (EAT).'
                  ELSE 'Submit your departmental budget on the Department Budget page.' END,
        jsonb_build_object(
          'kind', 'budget_cycle_open',
          'call_id', _call_id,
          'cycle_title', v_call.title,
          'department_id', r.department_id,
          'department_name', r.department_name,
          'deadline', v_call.deadline,
          'link', '/budgets'
        )
      );
      v_sent := v_sent + 1;
    END IF;
  END LOOP;

  RETURN v_sent;
END; $function$;

CREATE OR REPLACE FUNCTION public.budget_create_cycle(p_title text, p_financial_year text, p_period_type text, p_period_start date, p_period_end date, p_deadline timestamp with time zone, p_instructions text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised to create budget cycles'; END IF;
  IF p_title IS NULL OR length(trim(p_title)) < 3 THEN RAISE EXCEPTION 'Title is required'; END IF;
  INSERT INTO budget_calls(title, financial_year, period_type, period_start, period_end, deadline, instructions,
                           status, issued_by_user_id)
  VALUES (trim(p_title), p_financial_year, COALESCE(p_period_type,'monthly'), p_period_start, p_period_end,
          p_deadline, p_instructions, 'open', v_uid)
  RETURNING id INTO v_id;

  PERFORM public.budget_notify_cycle_open(v_id);
  RETURN v_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.budget_notify_cycle_open_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'open' AND (TG_OP = 'INSERT' OR COALESCE(OLD.status,'') <> 'open') THEN
    PERFORM public.budget_notify_cycle_open(NEW.id);
  END IF;
  RETURN NULL;
END; $function$;

DROP TRIGGER IF EXISTS trg_budget_notify_cycle_open ON public.budget_calls;
CREATE TRIGGER trg_budget_notify_cycle_open
AFTER INSERT OR UPDATE OF status ON public.budget_calls
FOR EACH ROW EXECUTE FUNCTION public.budget_notify_cycle_open_trg();

CREATE OR REPLACE FUNCTION public.budget_user_department_ids(_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT DISTINCT d.id
    FROM hr_departments d
    JOIN hr_assignments a ON a.department_id = d.id
    JOIN hr_staff s ON s.id = a.staff_id
   WHERE d.active
     AND (a.ended_on IS NULL OR a.ended_on >= CURRENT_DATE)
     AND s.user_id = _user_id
  UNION
  SELECT DISTINCT d.id
    FROM hr_departments d
    JOIN operations_departments od ON lower(od.department) = lower(d.key)
   WHERE d.active AND od.user_id = _user_id;
$function$;
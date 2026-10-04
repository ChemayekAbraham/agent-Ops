CREATE TABLE IF NOT EXISTS public.budget_department_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES public.budget_calls(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES public.hr_departments(id) ON DELETE CASCADE,
  title text NOT NULL,
  message text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, department_id)
);

GRANT SELECT ON public.budget_department_notifications TO authenticated;
GRANT ALL ON public.budget_department_notifications TO service_role;
ALTER TABLE public.budget_department_notifications ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.budget_department_notification_reads (
  notification_id uuid NOT NULL REFERENCES public.budget_department_notifications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

GRANT SELECT, INSERT ON public.budget_department_notification_reads TO authenticated;
GRANT ALL ON public.budget_department_notification_reads TO service_role;
ALTER TABLE public.budget_department_notification_reads ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.budget_can_access_department(_department_id uuid, _user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM operations_departments od
      JOIN hr_departments d ON lower(d.key) = lower(od.department)
     WHERE d.id = _department_id
       AND d.active
       AND od.user_id = _user_id
  );
$$;

DROP POLICY IF EXISTS "dept access can read budget dept notices" ON public.budget_department_notifications;
CREATE POLICY "dept access can read budget dept notices"
ON public.budget_department_notifications
FOR SELECT TO authenticated
USING (public.budget_can_access_department(department_id, auth.uid()));

DROP POLICY IF EXISTS "own read receipts" ON public.budget_department_notification_reads;
CREATE POLICY "own read receipts"
ON public.budget_department_notification_reads
FOR SELECT TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "insert own read receipts" ON public.budget_department_notification_reads;
CREATE POLICY "insert own read receipts"
ON public.budget_department_notification_reads
FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid());

CREATE TRIGGER trg_budget_dept_notifications_touch
BEFORE UPDATE ON public.budget_department_notifications
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

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

  FOR r IN SELECT d.id AS department_id, d.name AS department_name
             FROM hr_departments d
            WHERE d.active
  LOOP
    INSERT INTO budget_department_notifications(call_id, department_id, title, message, metadata)
    VALUES (
      _call_id,
      r.department_id,
      'Budget cycle open: ' || v_call.title,
      'The budget cycle "' || v_call.title || '" is open for ' || r.department_name || '. '
        || CASE WHEN v_call.deadline IS NOT NULL
                THEN 'Submit the departmental budget by '
                     || to_char(v_call.deadline AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY HH24:MI') || ' (EAT).'
                ELSE 'Submit the departmental budget on the Department Budgets page.' END,
      jsonb_build_object(
        'kind', 'budget_cycle_open',
        'call_id', _call_id,
        'cycle_title', v_call.title,
        'department_id', r.department_id,
        'department_name', r.department_name,
        'deadline', v_call.deadline,
        'link', '/budgets'
      )
    )
    ON CONFLICT (call_id, department_id) DO NOTHING;

    IF FOUND THEN v_sent := v_sent + 1; END IF;
  END LOOP;

  RETURN v_sent;
END; $function$;

CREATE OR REPLACE FUNCTION public.get_budget_department_notifications()
RETURNS TABLE (
  id uuid,
  call_id uuid,
  department_id uuid,
  department_name text,
  cycle_title text,
  deadline timestamptz,
  title text,
  message text,
  link text,
  created_at timestamptz,
  is_read boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT n.id,
         n.call_id,
         n.department_id,
         d.name AS department_name,
         c.title AS cycle_title,
         c.deadline,
         n.title,
         n.message,
         COALESCE(n.metadata->>'link', '/budgets') AS link,
         n.created_at,
         EXISTS (
           SELECT 1 FROM budget_department_notification_reads rr
            WHERE rr.notification_id = n.id AND rr.user_id = auth.uid()
         ) AS is_read
    FROM budget_department_notifications n
    JOIN hr_departments d ON d.id = n.department_id
    JOIN budget_calls c ON c.id = n.call_id
   WHERE d.active
     AND public.budget_can_access_department(n.department_id, auth.uid())
   ORDER BY n.created_at DESC
   LIMIT 50;
$$;

CREATE OR REPLACE FUNCTION public.mark_budget_department_notification_read(_notification_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_dept uuid;
BEGIN
  SELECT department_id INTO v_dept FROM budget_department_notifications WHERE id = _notification_id;
  IF v_dept IS NULL THEN RAISE EXCEPTION 'Notification not found'; END IF;
  IF NOT public.budget_can_access_department(v_dept, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorised for this department';
  END IF;
  INSERT INTO budget_department_notification_reads(notification_id, user_id)
  VALUES (_notification_id, auth.uid())
  ON CONFLICT DO NOTHING;
END; $$;

GRANT EXECUTE ON FUNCTION public.get_budget_department_notifications() TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_budget_department_notification_read(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.budget_can_access_department(uuid, uuid) TO authenticated;

INSERT INTO public.budget_department_notifications(call_id, department_id, title, message, metadata)
SELECT c.id,
       d.id,
       'Budget cycle open: ' || c.title,
       'The budget cycle "' || c.title || '" is open for ' || d.name || '. '
         || CASE WHEN c.deadline IS NOT NULL
                 THEN 'Submit the departmental budget by '
                      || to_char(c.deadline AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY HH24:MI') || ' (EAT).'
                 ELSE 'Submit the departmental budget on the Department Budgets page.' END,
       jsonb_build_object(
         'kind', 'budget_cycle_open',
         'call_id', c.id,
         'cycle_title', c.title,
         'department_id', d.id,
         'department_name', d.name,
         'deadline', c.deadline,
         'link', '/budgets'
       )
  FROM public.budget_calls c
  CROSS JOIN public.hr_departments d
 WHERE c.status = 'open' AND d.active
ON CONFLICT (call_id, department_id) DO NOTHING;
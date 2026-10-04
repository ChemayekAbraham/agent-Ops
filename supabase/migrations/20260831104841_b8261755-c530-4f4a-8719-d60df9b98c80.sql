-- 1. Repoint routing columns at hr_staff
ALTER TABLE public.cc_feedback DROP CONSTRAINT IF EXISTS cc_feedback_routed_to_expected_fkey;
ALTER TABLE public.cc_feedback DROP CONSTRAINT IF EXISTS cc_feedback_routed_to_actual_fkey;
ALTER TABLE public.cc_feedback
  ADD CONSTRAINT cc_feedback_routed_to_expected_fkey
  FOREIGN KEY (routed_to_expected) REFERENCES public.hr_staff(id);
ALTER TABLE public.cc_feedback
  ADD CONSTRAINT cc_feedback_routed_to_actual_fkey
  FOREIGN KEY (routed_to_actual) REFERENCES public.hr_staff(id);

-- 2. hr_tickets link back to the call attempt
ALTER TABLE public.hr_tickets
  ADD COLUMN IF NOT EXISTS call_attempt_id uuid NULL REFERENCES public.cc_call_attempts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS hr_tickets_call_attempt_id_idx ON public.hr_tickets (call_attempt_id);

-- 3. hr_tasks required_role + assignment guard
ALTER TABLE public.hr_tasks
  ADD COLUMN IF NOT EXISTS required_role public.app_role NULL;

CREATE OR REPLACE FUNCTION public.hr_task_required_role_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  IF NEW.assignee_staff_id IS NULL OR NEW.required_role IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.user_id INTO v_user FROM public.hr_staff s WHERE s.id = NEW.assignee_staff_id;

  IF v_user IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_user
      AND ur.role = NEW.required_role
      AND COALESCE(ur.enabled, true)
  ) THEN
    RAISE EXCEPTION 'This task may only be assigned to a holder of the required role.';
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_task_required_role_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_hr_task_required_role_guard ON public.hr_tasks;
CREATE TRIGGER trg_hr_task_required_role_guard
  BEFORE INSERT OR UPDATE ON public.hr_tasks
  FOR EACH ROW EXECUTE FUNCTION public.hr_task_required_role_guard();

-- 4. Category surface + raises_ticket
ALTER TABLE public.cc_feedback_categories
  ADD COLUMN IF NOT EXISTS surface_id uuid NULL REFERENCES public.hr_ticket_surfaces(id),
  ADD COLUMN IF NOT EXISTS raises_ticket boolean NOT NULL DEFAULT true;

UPDATE public.cc_feedback_categories c
   SET surface_id = s.id, raises_ticket = true
  FROM public.hr_ticket_surfaces s
 WHERE s.key = 'agents' AND c.code = 'agent_misconduct';

UPDATE public.cc_feedback_categories c
   SET surface_id = s.id, raises_ticket = true
  FROM public.hr_ticket_surfaces s
 WHERE s.key = 'tenancy' AND c.code = 'unit_condition';

UPDATE public.cc_feedback_categories c
   SET surface_id = s.id, raises_ticket = true
  FROM public.hr_ticket_surfaces s
 WHERE s.key = 'payments' AND c.code = 'payment_dispute';

UPDATE public.cc_feedback_categories c
   SET surface_id = s.id, raises_ticket = true
  FROM public.hr_ticket_surfaces s
 WHERE s.key = 'other' AND c.code IN ('app_fault','service_complaint','product_interest','data_correction');

UPDATE public.cc_feedback_categories
   SET surface_id = NULL, raises_ticket = false
 WHERE code = 'no_issue';

-- helper: single enabled holder of a role, as hr_staff.id
CREATE OR REPLACE FUNCTION public.cc_sole_role_staff(p_role public.app_role)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id
  FROM public.hr_staff s
  JOIN public.user_roles ur ON ur.user_id = s.user_id
  WHERE p_role IS NOT NULL
    AND ur.role = p_role
    AND COALESCE(ur.enabled, true)
    AND s.active
  GROUP BY s.id
  HAVING count(*) >= 1
  LIMIT 2
$$;

CREATE OR REPLACE FUNCTION public.cc_expected_owner_staff(p_role public.app_role)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  IF p_role IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT array_agg(x) INTO v_ids FROM (
    SELECT DISTINCT s.id AS x
    FROM public.hr_staff s
    JOIN public.user_roles ur ON ur.user_id = s.user_id
    WHERE ur.role = p_role
      AND COALESCE(ur.enabled, true)
      AND s.active
    LIMIT 3
  ) q;

  IF v_ids IS NULL OR array_length(v_ids, 1) <> 1 THEN
    RETURN NULL;
  END IF;

  RETURN v_ids[1];
END;
$$;

DROP FUNCTION IF EXISTS public.cc_sole_role_staff(public.app_role);

-- department resolution for pooled/assigned call centre tasks
CREATE OR REPLACE FUNCTION public.cc_task_department(p_staff_id uuid, p_role public.app_role)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dept uuid;
BEGIN
  IF p_staff_id IS NOT NULL THEN
    SELECT a.department_id INTO v_dept
    FROM public.hr_assignments a
    WHERE a.staff_id = p_staff_id AND a.ended_on IS NULL
    ORDER BY a.is_primary DESC NULLS LAST, a.started_on DESC NULLS LAST
    LIMIT 1;
    IF v_dept IS NOT NULL THEN
      RETURN v_dept;
    END IF;
  END IF;

  IF p_role IS NOT NULL THEN
    SELECT d.id INTO v_dept FROM public.hr_departments d
    WHERE d.name = CASE p_role
      WHEN 'tenant_ops'    THEN 'Tenant Ops'
      WHEN 'landlord_ops'  THEN 'Landlord Ops'
      WHEN 'agent_ops'     THEN 'Agent Ops'
      WHEN 'partner_ops'   THEN 'Partner Ops'
      WHEN 'financial_ops' THEN 'Finance'
      WHEN 'cfo'           THEN 'Finance'
      WHEN 'cto'           THEN 'Engineering & Product'
      WHEN 'hr'            THEN 'Support and Welfare'
      WHEN 'operations'    THEN 'Operations'
      WHEN 'crm'           THEN 'Customer Care'
      ELSE 'Customer Care'
    END
    LIMIT 1;
    IF v_dept IS NOT NULL THEN
      RETURN v_dept;
    END IF;
  END IF;

  SELECT d.id INTO v_dept FROM public.hr_departments d WHERE d.name = 'Customer Care' LIMIT 1;
  IF v_dept IS NULL THEN
    SELECT d.id INTO v_dept FROM public.hr_departments d ORDER BY d.name LIMIT 1;
  END IF;
  RETURN v_dept;
END;
$$;

-- 5. cc_raise_from_feedback
CREATE OR REPLACE FUNCTION public.cc_raise_from_feedback(p_feedback_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f public.cc_feedback;
  cat public.cc_feedback_categories;
  att public.cc_call_attempts;
  row_rec public.cc_cycle_rows;
  v_title text;
  v_priority public.hr_task_priority;
  v_due timestamptz;
  v_creator uuid;
  v_assignee uuid;
  v_required public.app_role;
  v_dept uuid;
  v_task_id uuid;
  v_ticket_id uuid;
BEGIN
  SELECT * INTO f FROM public.cc_feedback WHERE id = p_feedback_id;
  IF f.id IS NULL THEN
    RAISE EXCEPTION 'Feedback % not found.', p_feedback_id;
  END IF;

  SELECT * INTO cat FROM public.cc_feedback_categories WHERE id = f.category_id;
  SELECT * INTO att FROM public.cc_call_attempts WHERE id = f.attempt_id;
  SELECT * INTO row_rec FROM public.cc_cycle_rows WHERE id = att.cycle_row_id;

  IF NOT cat.raises_ticket THEN
    RETURN NULL;
  END IF;

  v_title := cat.label || ' — ' || row_rec.subject_type::text;

  v_priority := CASE f.severity
    WHEN 'critical' THEN 'urgent'::public.hr_task_priority
    WHEN 'high'     THEN 'high'::public.hr_task_priority
    ELSE 'normal'::public.hr_task_priority
  END;

  v_due := now() + CASE f.severity
    WHEN 'critical' THEN interval '1 day'
    WHEN 'high'     THEN interval '3 days'
    ELSE interval '7 days'
  END;

  SELECT s.id INTO v_creator FROM public.hr_staff s WHERE s.user_id = att.caller_id LIMIT 1;

  IF cat.locked THEN
    v_assignee := NULL;
    v_required := cat.default_owner_role;
  ELSIF f.routed_to_actual IS NOT NULL THEN
    v_assignee := f.routed_to_actual;
    v_required := NULL;
  ELSE
    v_assignee := NULL;
    v_required := cat.default_owner_role;
  END IF;

  v_dept := public.cc_task_department(COALESCE(v_assignee, v_creator), v_required);

  INSERT INTO public.hr_tickets (
    raised_by, raised_at, title, body, severity, severity_basis,
    surface_id, origin, reporter_channel, reported_at, reporter_words,
    call_attempt_id
  ) VALUES (
    att.caller_id, now(), v_title, f.note, f.severity,
    'Call centre feedback, category ' || cat.code,
    cat.surface_id, 'external'::public.hr_ticket_origin, att.channel, att.recorded_at, f.note,
    att.id
  ) RETURNING id INTO v_ticket_id;

  INSERT INTO public.hr_tasks (
    title, description, department_id, assignee_staff_id, created_by_staff_id,
    priority, status, origin, due_at, required_role
  ) VALUES (
    v_title, f.note, v_dept, v_assignee, v_creator,
    v_priority, 'open'::public.hr_task_status, 'call_centre', v_due, v_required
  ) RETURNING id INTO v_task_id;

  UPDATE public.hr_tickets SET task_id = v_task_id WHERE id = v_ticket_id;
  UPDATE public.cc_feedback SET ticket_id = v_ticket_id WHERE id = f.id;

  RETURN v_ticket_id;
END;
$$;

REVOKE ALL ON FUNCTION public.cc_raise_from_feedback(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cc_raise_from_feedback(uuid) TO authenticated;

-- 6. AFTER INSERT trigger on cc_feedback
CREATE OR REPLACE FUNCTION public.cc_feedback_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.cc_raise_from_feedback(NEW.id);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.cc_feedback_after_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_cc_feedback_after_insert ON public.cc_feedback;
CREATE TRIGGER trg_cc_feedback_after_insert
  AFTER INSERT ON public.cc_feedback
  FOR EACH ROW EXECUTE FUNCTION public.cc_feedback_after_insert();

-- 7. extend existing BEFORE INSERT function to stamp routed_to_expected
CREATE OR REPLACE FUNCTION public.cc_feedback_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_locked boolean;
  v_role public.app_role;
BEGIN
  SELECT locked, default_owner_role INTO v_locked, v_role
  FROM public.cc_feedback_categories WHERE id = NEW.category_id;

  IF v_locked IS NULL THEN
    RAISE EXCEPTION 'Unknown feedback category %.', NEW.category_id;
  END IF;

  IF v_locked THEN
    IF NEW.routed_to_actual IS NOT NULL THEN
      RAISE EXCEPTION 'This category is locked and cannot be routed to a chosen assignee.';
    END IF;
    NEW.routed_to_actual := NULL;
  END IF;

  IF NEW.routed_to_expected IS NULL THEN
    NEW.routed_to_expected := public.cc_expected_owner_staff(v_role);
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.cc_feedback_before_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cc_expected_owner_staff(public.app_role) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cc_task_department(uuid, public.app_role) FROM PUBLIC, anon, authenticated;
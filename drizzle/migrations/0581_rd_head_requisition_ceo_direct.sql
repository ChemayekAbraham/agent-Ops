CREATE OR REPLACE FUNCTION public.staff_requisition_ceo_direct(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.budget_department_heads h
    JOIN public.hr_departments d ON d.id = h.department_id
    WHERE h.user_id = _user_id AND h.active
      AND d.key = 'product_research_and_development')
$$;
REVOKE ALL ON FUNCTION public.staff_requisition_ceo_direct(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_requisition_ceo_direct(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.staff_requisition_route(_user_id uuid)
 RETURNS TABLE(department_id uuid, department_key text, department_name text, stage text, approver_role text, final_stage text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_dept_id uuid; v_key text; v_name text;
BEGIN
  SELECT d.id, d.key, d.name INTO v_dept_id, v_key, v_name
    FROM hr_departments d
    JOIN hr_assignments a ON a.department_id = d.id
    JOIN hr_staff s ON s.id = a.staff_id
   WHERE d.active AND s.user_id = _user_id
     AND (a.ended_on IS NULL OR a.ended_on >= CURRENT_DATE)
   ORDER BY a.is_primary DESC NULLS LAST, a.started_on DESC NULLS LAST
   LIMIT 1;

  IF v_dept_id IS NULL THEN
    SELECT d.id, d.key, d.name INTO v_dept_id, v_key, v_name
      FROM hr_departments d
      JOIN operations_departments od ON lower(od.department) = lower(d.key)
     WHERE d.active AND od.user_id = _user_id
     LIMIT 1;
  END IF;

  -- Exception: the head of Product Research and Development goes CEO -> CFO.
  IF public.staff_requisition_ceo_direct(_user_id) THEN
    SELECT d.id, d.key, d.name INTO v_dept_id, v_key, v_name
      FROM hr_departments d WHERE d.key = 'product_research_and_development' LIMIT 1;
    RETURN QUERY SELECT v_dept_id, v_key, v_name, 'ceo'::text, 'ceo'::text, 'cfo'::text;
    RETURN;
  END IF;

  IF v_dept_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT v_dept_id, v_key, v_name, 'coo'::text, 'coo'::text, 'cfo'::text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.staff_requisition_six_eyes_guard()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_open constant text[] := ARRAY['supervisor', 'coo', 'ceo', 'cfo'];
  v_direct boolean;
BEGIN
  IF COALESCE(NEW.request_kind, 'requisition') <> 'requisition' THEN
    RETURN NEW;
  END IF;

  v_direct := public.staff_requisition_ceo_direct(NEW.requester_id);

  IF TG_OP = 'INSERT' THEN
    IF v_direct THEN
      NEW.stage := 'ceo';
      NEW.current_approver_role := 'ceo';
    ELSIF NEW.stage IS DISTINCT FROM 'supervisor' THEN
      NEW.stage := 'coo';
      NEW.current_approver_role := 'coo';
    END IF;
    NEW.final_stage := 'cfo';
    NEW.supervisor_decided_by := NULL; NEW.supervisor_decided_at := NULL;
    NEW.hr_decided_by := NULL;         NEW.hr_decided_at := NULL;
    NEW.coo_decided_by := NULL;        NEW.coo_decided_at := NULL;
    NEW.ceo_decided_by := NULL;        NEW.ceo_decided_at := NULL;
    NEW.cfo_decided_by := NULL;        NEW.cfo_decided_at := NULL;
    NEW.approved_amount := NULL;
    NEW.wallet_credit_status := NULL;
    NEW.decided_at := NULL;
    RETURN NEW;
  END IF;

  IF OLD.stage = ANY (v_open)
     AND NEW.approved_amount IS NOT NULL
     AND NEW.approved_amount > COALESCE(OLD.approved_amount, OLD.amount) THEN
    RAISE EXCEPTION 'Six-eyes approval: an approver cannot raise the amount above what earlier approvers saw (%).',
      COALESCE(OLD.approved_amount, OLD.amount);
  END IF;

  -- R&D head resubmissions that would restart at supervisor/COO restart at CEO instead.
  IF v_direct AND OLD.stage = 'returned' AND NEW.stage IN ('supervisor', 'coo') THEN
    NEW.stage := 'ceo';
    NEW.current_approver_role := 'ceo';
  END IF;

  IF NEW.stage IS NOT DISTINCT FROM OLD.stage THEN
    RETURN NEW;
  END IF;

  IF OLD.stage = ANY (v_open) AND NEW.stage IN ('rejected', 'returned') THEN
    RETURN NEW;
  END IF;

  IF OLD.stage = 'supervisor' AND NEW.stage = 'coo' THEN
    IF NEW.supervisor_decided_by IS NULL OR NEW.supervisor_decided_by = NEW.requester_id THEN
      RAISE EXCEPTION 'Six-eyes approval: the department sign-off is missing or is the requester.';
    END IF;

  ELSIF OLD.stage = 'coo' AND NEW.stage = 'ceo' THEN
    PERFORM public.staff_requisition_assert_signer(NEW.coo_decided_by, 'coo', NEW.requester_id, ARRAY[NEW.supervisor_decided_by]);

  ELSIF OLD.stage = 'ceo' AND NEW.stage = 'cfo' THEN
    PERFORM public.staff_requisition_assert_signer(NEW.ceo_decided_by, 'ceo', NEW.requester_id, ARRAY[NEW.supervisor_decided_by, NEW.coo_decided_by]);

  ELSIF OLD.stage = 'cfo' AND NEW.stage = 'approved' THEN
    IF NOT (v_direct AND NEW.coo_decided_by IS NULL) THEN
      PERFORM public.staff_requisition_assert_signer(NEW.coo_decided_by, 'coo', NEW.requester_id, ARRAY[NEW.supervisor_decided_by]);
    END IF;
    PERFORM public.staff_requisition_assert_signer(NEW.ceo_decided_by, 'ceo', NEW.requester_id, ARRAY[NEW.supervisor_decided_by, NEW.coo_decided_by]);
    PERFORM public.staff_requisition_assert_signer(NEW.cfo_decided_by, 'cfo', NEW.requester_id, ARRAY[NEW.supervisor_decided_by, NEW.coo_decided_by, NEW.ceo_decided_by]);

  ELSIF OLD.stage = 'approved' AND NEW.stage = 'cfo'
        AND NEW.wallet_credit_status = 'failed'
        AND COALESCE(OLD.wallet_credit_status, '') <> 'credited' THEN
    NULL;

  ELSIF OLD.stage = 'returned' AND NEW.stage = ANY (v_open) THEN
    IF NEW.amount > OLD.amount
       AND (NEW.coo_decided_by IS NOT NULL OR NEW.ceo_decided_by IS NOT NULL OR NEW.cfo_decided_by IS NOT NULL) THEN
      RAISE EXCEPTION 'Six-eyes approval: a resubmission that raises the amount must restart approval from the beginning.';
    END IF;
    IF NEW.stage NOT IN ('supervisor', 'coo') AND NEW.stage IS DISTINCT FROM OLD.returned_from_stage
       AND NOT (v_direct AND NEW.stage = 'ceo') THEN
      RAISE EXCEPTION 'Six-eyes approval: a resubmission can only return to the stage that sent it back (%).', OLD.returned_from_stage;
    END IF;

  ELSE
    RAISE EXCEPTION 'Six-eyes approval: illegal requisition stage change % -> %.', OLD.stage, NEW.stage;
  END IF;

  RETURN NEW;
END;
$function$;
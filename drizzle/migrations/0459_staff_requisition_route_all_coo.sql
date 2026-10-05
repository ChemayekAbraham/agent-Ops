CREATE OR REPLACE FUNCTION public.staff_requisition_route(_user_id uuid)
 RETURNS TABLE(department_id uuid, department_key text, department_name text, stage text, approver_role text, final_stage text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dept_id uuid; v_key text; v_name text;
BEGIN
  -- Department lookup unchanged: primary HR assignment first, then operations_departments.
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

  -- Staff with no department: unchanged (returns nothing).
  IF v_dept_id IS NULL THEN
    RETURN;
  END IF;

  -- Department-head stage retired: every staff member with a department
  -- starts at the COO desk, then CEO, then CFO.
  RETURN QUERY SELECT v_dept_id, v_key, v_name, 'coo'::text, 'coo'::text, 'cfo'::text;
END;
$function$;

COMMENT ON FUNCTION public.staff_requisition_route(uuid) IS 'SRQ-FLOW-07: department-head stage retired for new requisitions; all staff with a department route COO -> CEO -> CFO. In-flight requisitions untouched; staff_requisition_department_routes rows retained but no longer read.';
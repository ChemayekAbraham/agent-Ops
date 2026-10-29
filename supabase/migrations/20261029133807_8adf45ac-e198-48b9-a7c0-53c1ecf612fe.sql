CREATE OR REPLACE FUNCTION public.budget_submit_submission(p_submission_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_sub budget_submissions; v_call budget_calls;
  v_late boolean := false; v_lines int; v_route text; v_status text; v_total numeric; v_rev uuid;
  v_is_revision boolean := false;
BEGIN
  SELECT * INTO v_sub FROM budget_submissions WHERE id = p_submission_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF NOT public.can_access_budget_submission(p_submission_id, v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF v_sub.status <> 'draft' THEN RAISE EXCEPTION 'Only draft budgets can be submitted'; END IF;
  SELECT COUNT(*) INTO v_lines FROM budget_submission_lines WHERE submission_id = p_submission_id;
  IF v_lines = 0 THEN RAISE EXCEPTION 'Add at least one budget line before submitting'; END IF;
  SELECT * INTO v_call FROM budget_calls WHERE id = v_sub.call_id;
  v_is_revision := v_sub.parent_submission_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM budget_submissions p
    WHERE p.id = v_sub.parent_submission_id AND p.status = 'revision_requested'
      AND p.call_id = v_sub.call_id AND p.department_id = v_sub.department_id);
  IF v_call.status <> 'open' AND NOT (v_is_revision AND v_call.status = 'closed') THEN
    RAISE EXCEPTION 'Budget cycle % is %, submissions are no longer accepted', v_call.title, v_call.status;
  END IF;
  v_late := NOT v_is_revision AND v_call.deadline IS NOT NULL AND now() > v_call.deadline;
  v_route := public.budget_department_route(v_sub.department_id);
  v_status := CASE WHEN v_route = 'coo' THEN 'pending_coo' ELSE 'submitted' END;
  SELECT COALESCE(SUM(line_total),0) INTO v_total
    FROM budget_submission_lines WHERE submission_id = p_submission_id;
  UPDATE budget_submissions
     SET status = v_status, submitted_at = now(), is_late = v_late, total_amount = v_total,
         submitted_by_user_id = COALESCE(submitted_by_user_id, v_uid)
   WHERE id = p_submission_id;

  IF v_route = 'coo' THEN
    v_rev := public.budget_first_level_reviewer_dept(v_sub.department_id);
    IF v_rev IS NOT NULL AND EXISTS (
         SELECT 1 FROM budget_department_heads h WHERE h.department_id = v_rev AND h.active) THEN
      PERFORM public.budget_notify(h.user_id, 'Department budget awaiting your approval',
        'Budget '||v_sub.reference||' needs your first-level review before it reaches the CFO.',
        jsonb_build_object('submission_id', p_submission_id, 'stage','coo'))
      FROM budget_department_heads h
      WHERE h.department_id = v_rev AND h.active
        AND h.user_id IS DISTINCT FROM COALESCE(v_sub.submitted_by_user_id, v_uid);
    ELSE
      PERFORM public.budget_notify(ur.user_id, 'Department budget awaiting your approval',
        'Budget '||v_sub.reference||' from your operations department needs COO review before it reaches the CFO.',
        jsonb_build_object('submission_id', p_submission_id, 'stage','coo'))
      FROM user_roles ur WHERE ur.role = 'coo';
    END IF;
  ELSE
    PERFORM public.budget_notify(v_call.issued_by_user_id, 'Department budget submitted',
      'Budget '||v_sub.reference||' was submitted for review'||CASE WHEN v_late THEN ' (after the deadline)' ELSE '' END||'.',
      jsonb_build_object('submission_id', p_submission_id, 'late', v_late));
    PERFORM public.budget_notify(ur.user_id, 'Department budget submitted',
      'Budget '||v_sub.reference||' reached the CFO review queue.',
      jsonb_build_object('submission_id', p_submission_id, 'stage','cfo'))
    FROM user_roles ur WHERE ur.role = 'cfo';
  END IF;

  PERFORM public.budget_log_event(p_submission_id, 'submitted',
    jsonb_build_object('route', v_route, 'status_after', v_status, 'total_amount', v_total, 'is_late', v_late, 'revision', v_is_revision));
  RETURN jsonb_build_object('submission_id', p_submission_id, 'status', v_status, 'route', v_route, 'is_late', v_late);
END;
$function$;
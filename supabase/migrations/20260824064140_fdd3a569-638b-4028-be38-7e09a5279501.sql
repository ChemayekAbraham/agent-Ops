CREATE OR REPLACE FUNCTION public.budget_review_queue(p_call_id uuid, p_stage text DEFAULT 'cfo'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_rows jsonb;
BEGIN
  IF p_stage NOT IN ('cfo','coo') THEN RAISE EXCEPTION 'Invalid stage'; END IF;
  IF p_stage = 'cfo' AND NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF p_stage = 'coo' AND NOT public.is_budget_coo_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'submitted_at' DESC NULLS LAST), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'id', s.id, 'reference', s.reference, 'title', s.title, 'purpose', s.purpose,
      'call_id', s.call_id, 'cycle_title', c.title,
      'department_id', s.department_id, 'department_name', COALESCE(d.name,'Unassigned'),
      'department_key', d.key,
      'route', public.budget_department_route(s.department_id),
      'status', s.status, 'version', s.version, 'is_late', s.is_late,
      'submitted_at', s.submitted_at, 'created_at', s.created_at,
      'reviewed_at', s.reviewed_at, 'cfo_comment', s.cfo_comment,
      'coo_reviewed_at', s.coo_reviewed_at, 'coo_comment', s.coo_comment,
      'line_count', agg.line_count,
      'total_amount', agg.requested_total,
      'cfo_approved_total', agg.cfo_approved_total,
      'coo_approved_total', agg.coo_approved_total,
      'pending_lines', CASE WHEN p_stage = 'coo' THEN agg.coo_pending ELSE agg.cfo_pending END
    ) AS x, s.submitted_at
    FROM budget_submissions s
    LEFT JOIN hr_departments d ON d.id = s.department_id
    LEFT JOIN budget_calls c ON c.id = s.call_id
    CROSS JOIN LATERAL (
      SELECT COUNT(*) AS line_count,
             COALESCE(SUM(l.line_total),0) AS requested_total,
             COALESCE(SUM(CASE WHEN l.status = 'approved' THEN l.approved_amount END),0) AS cfo_approved_total,
             COALESCE(SUM(CASE WHEN l.coo_status = 'approved' THEN l.coo_approved_amount END),0) AS coo_approved_total,
             COUNT(*) FILTER (WHERE l.status = 'pending') AS cfo_pending,
             COUNT(*) FILTER (WHERE l.coo_status = 'pending') AS coo_pending
      FROM budget_submission_lines l WHERE l.submission_id = s.id
    ) agg
    WHERE (p_call_id IS NULL OR s.call_id = p_call_id)
      AND (
        (p_stage = 'coo'
          AND public.budget_department_route(s.department_id) = 'coo'
          AND s.status <> 'draft')
        OR
        (p_stage = 'cfo' AND s.status NOT IN ('draft','pending_coo','coo_under_review'))
      )
  ) q;

  RETURN jsonb_build_object('stage', p_stage, 'rows', v_rows);
END; $function$;
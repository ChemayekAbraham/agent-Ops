-- 1. Event-derived status must never downgrade / bypass the COO stage.
CREATE OR REPLACE FUNCTION public.budget_submission_derive_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  latest_event text;
  v_status text;
  v_route text;
BEGIN
  SELECT event_type INTO latest_event
  FROM budget_submission_events
  WHERE submission_id = NEW.submission_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF latest_event IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.status, public.budget_department_route(s.department_id)
    INTO v_status, v_route
  FROM budget_submissions s WHERE s.id = NEW.submission_id;

  -- COO-routed submissions own their own stage transitions. Never let a
  -- generic event log move them out of (or past) the COO stage.
  IF v_route = 'coo' AND v_status IN ('pending_coo','coo_under_review','rejected','revision_requested') THEN
    RETURN NEW;
  END IF;

  UPDATE budget_submissions
  SET
    status = CASE latest_event
      WHEN 'submitted'          THEN 'submitted'
      WHEN 'returned'           THEN 'returned'
      WHEN 'approved'           THEN 'approved'
      WHEN 'release_previewed'  THEN 'approved'
      WHEN 'released'           THEN 'released'
      WHEN 'paid'               THEN 'paid'
      WHEN 'cancelled'          THEN 'cancelled'
      ELSE status
    END,
    updated_at = now()
  WHERE id = NEW.submission_id;

  RETURN NEW;
END;
$$;

-- 2. CFO queue: an operations (COO-routed) budget is only CFO-ready once the
--    COO forwarded it. Direct-route departments are unchanged.
CREATE OR REPLACE FUNCTION public.budget_review_queue(p_call_id uuid DEFAULT NULL, p_stage text DEFAULT 'cfo')
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
        (p_stage = 'cfo'
          AND s.status NOT IN ('draft','pending_coo','coo_under_review')
          AND (
            public.budget_department_route(s.department_id) <> 'coo'
            OR (
              s.coo_reviewed_at IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM budget_submission_events e
                WHERE e.submission_id = s.id AND e.event_type = 'coo_forwarded'
              )
            )
          ))
      )
  ) q;

  RETURN jsonb_build_object('stage', p_stage, 'rows', v_rows);
END;
$$;

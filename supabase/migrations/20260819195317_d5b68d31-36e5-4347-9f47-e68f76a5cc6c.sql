-- ===== Department Budgets: COO routing stage (extends existing budget workflow) =====

-- 0. Ensure the four operations departments exist (data seed only)
INSERT INTO public.hr_departments(key, name, active)
SELECT v.key, v.name, true
FROM (VALUES ('tenant_ops','Tenant Ops'), ('agent_ops','Agent Ops'),
             ('landlord_ops','Landlord Ops'), ('partner_ops','Partner Ops')) AS v(key,name)
WHERE NOT EXISTS (SELECT 1 FROM public.hr_departments d WHERE d.key = v.key);

-- 1. Status pipeline: add the COO stage only (existing statuses preserved)
ALTER TABLE public.budget_submissions DROP CONSTRAINT IF EXISTS budget_submissions_status_check;
ALTER TABLE public.budget_submissions ADD CONSTRAINT budget_submissions_status_check
  CHECK (status = ANY (ARRAY['draft','pending_coo','coo_under_review','submitted','under_review',
    'revision_requested','approved','rejected','superseded','returned','released','paid','cancelled']));

ALTER TABLE public.budget_submissions
  ADD COLUMN IF NOT EXISTS coo_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS coo_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS coo_comment text;

ALTER TABLE public.budget_submission_lines
  ADD COLUMN IF NOT EXISTS coo_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS coo_approved_amount numeric,
  ADD COLUMN IF NOT EXISTS coo_note text,
  ADD COLUMN IF NOT EXISTS coo_decided_by uuid,
  ADD COLUMN IF NOT EXISTS coo_decided_at timestamptz;
ALTER TABLE public.budget_submission_lines DROP CONSTRAINT IF EXISTS budget_lines_coo_status_check;
ALTER TABLE public.budget_submission_lines ADD CONSTRAINT budget_lines_coo_status_check
  CHECK (coo_status = ANY (ARRAY['pending','approved','rejected','revision_requested']));

-- 2. Audit event vocabulary
ALTER TABLE public.budget_submission_events DROP CONSTRAINT IF EXISTS budget_submission_events_event_type_check;
ALTER TABLE public.budget_submission_events ADD CONSTRAINT budget_submission_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'submitted','returned','approved','release_previewed','released','paid','cancelled',
    'created','updated','line_insert','line_update','line_delete',
    'status_draft','status_submitted','status_under_review','status_revision_requested',
    'status_approved','status_rejected','status_superseded','status_returned',
    'status_released','status_paid','status_cancelled','status_pending_coo','status_coo_under_review',
    'coo_line_decision','coo_forwarded','coo_returned','cfo_line_decision','cfo_finalized',
    'revision_requested'
  ]));

-- 3. Routing + authority helpers
CREATE OR REPLACE FUNCTION public.budget_department_route(_department_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM hr_departments d
     WHERE d.id = _department_id
       AND lower(d.key) IN ('tenant_ops','agent_ops','landlord_ops','partner_ops')
  ) THEN 'coo' ELSE 'direct' END;
$$;
GRANT EXECUTE ON FUNCTION public.budget_department_route(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_budget_coo_reviewer(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_role(_user_id,'coo') OR public.has_role(_user_id,'super_admin');
$$;
GRANT EXECUTE ON FUNCTION public.is_budget_coo_reviewer(uuid) TO authenticated, service_role;

-- Audit helper
CREATE OR REPLACE FUNCTION public.budget_log_event(_submission_id uuid, _event_type text, _payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO budget_submission_events(submission_id, event_type, actor_user_id, payload)
  VALUES (_submission_id, _event_type, auth.uid(), COALESCE(_payload,'{}'::jsonb));
EXCEPTION WHEN OTHERS THEN RETURN;
END; $$;

-- COO submissions are visible to the COO through RLS as well
DROP POLICY IF EXISTS budget_submissions_read ON public.budget_submissions;
CREATE POLICY budget_submissions_read ON public.budget_submissions FOR SELECT TO authenticated
  USING (public.is_budget_reviewer((SELECT auth.uid()))
         OR submitted_by_user_id = (SELECT auth.uid())
         OR department_id IN (SELECT public.budget_user_department_ids((SELECT auth.uid())))
         OR (public.is_budget_coo_reviewer((SELECT auth.uid()))
             AND public.budget_department_route(department_id) = 'coo'));

CREATE OR REPLACE FUNCTION public.can_access_budget_submission(_submission_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_budget_reviewer(_user_id)
      OR EXISTS (
        SELECT 1 FROM budget_submissions bs
        WHERE bs.id = _submission_id
          AND (bs.submitted_by_user_id = _user_id
               OR bs.department_id IN (SELECT public.budget_user_department_ids(_user_id))
               OR (public.is_budget_coo_reviewer(_user_id)
                   AND public.budget_department_route(bs.department_id) = 'coo'))
      );
$$;

-- 4. Submit: operations departments land in the COO queue first
CREATE OR REPLACE FUNCTION public.budget_submit_submission(p_submission_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_sub budget_submissions; v_call budget_calls;
  v_late boolean := false; v_lines int; v_route text; v_status text; v_total numeric;
BEGIN
  SELECT * INTO v_sub FROM budget_submissions WHERE id = p_submission_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF NOT public.can_access_budget_submission(p_submission_id, v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF v_sub.status <> 'draft' THEN RAISE EXCEPTION 'Only draft budgets can be submitted'; END IF;
  SELECT COUNT(*) INTO v_lines FROM budget_submission_lines WHERE submission_id = p_submission_id;
  IF v_lines = 0 THEN RAISE EXCEPTION 'Add at least one budget line before submitting'; END IF;

  SELECT * INTO v_call FROM budget_calls WHERE id = v_sub.call_id;
  IF v_call.status <> 'open' THEN
    RAISE EXCEPTION 'Budget cycle % is %, submissions are no longer accepted', v_call.title, v_call.status;
  END IF;
  v_late := v_call.deadline IS NOT NULL AND now() > v_call.deadline;
  v_route := public.budget_department_route(v_sub.department_id);
  v_status := CASE WHEN v_route = 'coo' THEN 'pending_coo' ELSE 'submitted' END;

  SELECT COALESCE(SUM(line_total),0) INTO v_total
    FROM budget_submission_lines WHERE submission_id = p_submission_id;

  UPDATE budget_submissions
     SET status = v_status, submitted_at = now(), is_late = v_late, total_amount = v_total,
         submitted_by_user_id = COALESCE(submitted_by_user_id, v_uid)
   WHERE id = p_submission_id;

  IF v_route = 'coo' THEN
    PERFORM public.budget_notify(ur.user_id, 'Department budget awaiting your approval',
      'Budget '||v_sub.reference||' from your operations department needs COO review before it reaches the CFO.',
      jsonb_build_object('submission_id', p_submission_id, 'stage','coo'))
    FROM user_roles ur WHERE ur.role = 'coo';
  ELSE
    PERFORM public.budget_notify(v_call.issued_by_user_id,
      'Department budget submitted',
      'Budget '||v_sub.reference||' was submitted for review'||CASE WHEN v_late THEN ' (after the deadline)' ELSE '' END||'.',
      jsonb_build_object('submission_id', p_submission_id, 'late', v_late));
    PERFORM public.budget_notify(ur.user_id, 'Department budget submitted',
      'Budget '||v_sub.reference||' reached the CFO review queue.',
      jsonb_build_object('submission_id', p_submission_id, 'stage','cfo'))
    FROM user_roles ur WHERE ur.role = 'cfo';
  END IF;

  PERFORM public.budget_log_event(p_submission_id, 'submitted',
    jsonb_build_object('route', v_route, 'status_after', v_status, 'total_amount', v_total, 'is_late', v_late));

  RETURN jsonb_build_object('submission_id', p_submission_id, 'status', v_status, 'route', v_route, 'is_late', v_late);
END; $$;

-- 5. COO stage actions
CREATE OR REPLACE FUNCTION public.budget_coo_start_review(p_submission_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sub budget_submissions;
BEGIN
  SELECT * INTO v_sub FROM budget_submissions WHERE id = p_submission_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF NOT public.is_budget_coo_reviewer(auth.uid())
     OR public.budget_department_route(v_sub.department_id) <> 'coo' THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  UPDATE budget_submissions SET coo_reviewed_by = auth.uid(), status = 'coo_under_review'
   WHERE id = p_submission_id AND status = 'pending_coo';
END; $$;

CREATE OR REPLACE FUNCTION public.budget_coo_decide_line(
  p_line_id uuid, p_decision text, p_approved_amount numeric, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_sub budget_submissions; v_line budget_submission_lines; v_amount numeric;
BEGIN
  SELECT * INTO v_line FROM budget_submission_lines WHERE id = p_line_id;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'Budget line not found'; END IF;
  SELECT * INTO v_sub FROM budget_submissions WHERE id = v_line.submission_id;
  IF NOT public.is_budget_coo_reviewer(v_uid)
     OR public.budget_department_route(v_sub.department_id) <> 'coo' THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  IF p_decision NOT IN ('approved','rejected','revision_requested','pending') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
  IF v_sub.status NOT IN ('pending_coo','coo_under_review') THEN
    RAISE EXCEPTION 'Submission is not open for COO review (%).', v_sub.status;
  END IF;

  IF p_decision = 'approved' THEN
    v_amount := COALESCE(p_approved_amount, v_line.line_total);
    IF v_amount < 0 THEN RAISE EXCEPTION 'Approved amount cannot be negative'; END IF;
    IF v_amount > COALESCE(v_line.line_total, 0) THEN
      RAISE EXCEPTION 'Approved amount cannot exceed the requested amount (%)', COALESCE(v_line.line_total,0);
    END IF;
  ELSE
    v_amount := 0;
  END IF;

  UPDATE budget_submission_lines
     SET coo_status = p_decision, coo_approved_amount = v_amount,
         coo_note = NULLIF(trim(COALESCE(p_note,'')),''), coo_decided_by = v_uid, coo_decided_at = now()
   WHERE id = p_line_id;

  UPDATE budget_submissions SET status = 'coo_under_review', coo_reviewed_by = v_uid
   WHERE id = v_sub.id AND status IN ('pending_coo','coo_under_review');

  PERFORM public.budget_log_event(v_sub.id, 'coo_line_decision', jsonb_build_object(
    'line_id', p_line_id, 'description', v_line.description,
    'decision_before', v_line.coo_status, 'decision_after', p_decision,
    'amount_before', v_line.coo_approved_amount, 'amount_after', v_amount,
    'requested_amount', v_line.line_total, 'note', NULLIF(trim(COALESCE(p_note,'')),'')));

  RETURN jsonb_build_object('line_id', p_line_id, 'coo_status', p_decision, 'coo_approved_amount', v_amount);
END; $$;

-- COO forwards an approved operations budget into the CFO queue
CREATE OR REPLACE FUNCTION public.budget_coo_forward_submission(p_submission_id uuid, p_comment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_sub budget_submissions; v_pending int; v_approved numeric;
BEGIN
  SELECT * INTO v_sub FROM budget_submissions WHERE id = p_submission_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF NOT public.is_budget_coo_reviewer(v_uid)
     OR public.budget_department_route(v_sub.department_id) <> 'coo' THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  IF v_sub.status NOT IN ('pending_coo','coo_under_review') THEN
    RAISE EXCEPTION 'Cannot forward in status %', v_sub.status;
  END IF;
  SELECT COUNT(*) INTO v_pending FROM budget_submission_lines
    WHERE submission_id = p_submission_id AND coo_status = 'pending';
  IF v_pending > 0 THEN RAISE EXCEPTION 'Decide all % remaining line item(s) first', v_pending; END IF;
  SELECT COUNT(*) INTO v_pending FROM budget_submission_lines
    WHERE submission_id = p_submission_id AND coo_status = 'approved';
  IF v_pending = 0 THEN RAISE EXCEPTION 'Approve at least one line item before forwarding to the CFO'; END IF;

  SELECT COALESCE(SUM(coo_approved_amount),0) INTO v_approved FROM budget_submission_lines
    WHERE submission_id = p_submission_id AND coo_status = 'approved';

  UPDATE budget_submissions
     SET status = 'submitted', coo_reviewed_at = now(), coo_reviewed_by = v_uid,
         coo_comment = NULLIF(trim(COALESCE(p_comment,'')),'')
   WHERE id = p_submission_id;

  PERFORM public.budget_notify(ur.user_id, 'Operations budget approved by COO',
    'Budget '||v_sub.reference||' passed COO review and is now in the CFO queue.',
    jsonb_build_object('submission_id', p_submission_id, 'stage','cfo'))
  FROM user_roles ur WHERE ur.role = 'cfo';

  PERFORM public.budget_notify(v_sub.submitted_by_user_id, 'COO approved your budget',
    'Budget '||v_sub.reference||' was approved by the COO and forwarded to the CFO.',
    jsonb_build_object('submission_id', p_submission_id));

  PERFORM public.budget_log_event(p_submission_id, 'coo_forwarded', jsonb_build_object(
    'status_before', v_sub.status, 'status_after','submitted',
    'coo_approved_total', v_approved, 'comment', NULLIF(trim(COALESCE(p_comment,'')),'')));

  RETURN jsonb_build_object('submission_id', p_submission_id, 'status','submitted', 'coo_approved_total', v_approved);
END; $$;

-- COO rejects or asks for revision: submission goes back to the department as a fresh draft
CREATE OR REPLACE FUNCTION public.budget_coo_return_submission(
  p_submission_id uuid, p_decision text, p_comment text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_sub budget_submissions; v_new uuid;
BEGIN
  SELECT * INTO v_sub FROM budget_submissions WHERE id = p_submission_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF NOT public.is_budget_coo_reviewer(v_uid)
     OR public.budget_department_route(v_sub.department_id) <> 'coo' THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  IF p_decision NOT IN ('rejected','revision_requested') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
  IF v_sub.status NOT IN ('pending_coo','coo_under_review') THEN
    RAISE EXCEPTION 'Cannot return in status %', v_sub.status;
  END IF;
  IF p_comment IS NULL OR length(trim(p_comment)) < 10 THEN
    RAISE EXCEPTION 'Provide a reason of at least 10 characters';
  END IF;

  UPDATE budget_submissions
     SET status = p_decision, coo_comment = trim(p_comment), coo_reviewed_at = now(), coo_reviewed_by = v_uid
   WHERE id = p_submission_id;

  INSERT INTO budget_submissions(call_id, department_id, reference, title, purpose, status, period_type,
      period_start, period_end, submitted_by_user_id, submitted_by_position_id, total_amount,
      version, parent_submission_id)
  VALUES (v_sub.call_id, v_sub.department_id,
      v_sub.reference||'-R'||(v_sub.version + 1), v_sub.title, v_sub.purpose, 'draft', v_sub.period_type,
      v_sub.period_start, v_sub.period_end, v_sub.submitted_by_user_id, v_sub.submitted_by_position_id, 0,
      v_sub.version + 1, p_submission_id)
  RETURNING id INTO v_new;

  INSERT INTO budget_submission_lines(submission_id, sort_order, description, category, account_code,
      quantity, unit_amount, period_month, justification, document_path, status)
  SELECT v_new, sort_order, description, category, account_code, quantity, unit_amount,
         period_month, justification, document_path, 'pending'
  FROM budget_submission_lines WHERE submission_id = p_submission_id ORDER BY sort_order;

  UPDATE budget_submissions
     SET total_amount = (SELECT COALESCE(SUM(line_total),0) FROM budget_submission_lines WHERE submission_id = v_new)
   WHERE id = v_new;

  PERFORM public.budget_notify(v_sub.submitted_by_user_id,
     CASE WHEN p_decision = 'rejected' THEN 'COO rejected your budget' ELSE 'COO requested a budget revision' END,
     'Budget '||v_sub.reference||': '||trim(p_comment),
     jsonb_build_object('submission_id', p_submission_id, 'new_submission_id', v_new));

  PERFORM public.budget_log_event(p_submission_id, 'coo_returned', jsonb_build_object(
    'status_before', v_sub.status, 'status_after', p_decision,
    'comment', trim(p_comment), 'new_submission_id', v_new));

  RETURN v_new;
END; $$;

-- 6. CFO stage: keep behaviour, add audit trail + notification breadth
CREATE OR REPLACE FUNCTION public.budget_decide_line(p_line_id uuid, p_decision text, p_approved_amount numeric, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_line budget_submission_lines; v_status text; v_amount numeric;
BEGIN
  IF NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF p_decision NOT IN ('approved','rejected','revision_requested','pending') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
  SELECT * INTO v_line FROM budget_submission_lines WHERE id = p_line_id;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'Budget line not found'; END IF;
  SELECT status INTO v_status FROM budget_submissions WHERE id = v_line.submission_id;
  IF v_status NOT IN ('submitted','under_review') THEN RAISE EXCEPTION 'Submission is not open for review (%).', v_status; END IF;

  IF p_decision = 'approved' THEN
    v_amount := COALESCE(p_approved_amount, v_line.line_total);
    IF v_amount < 0 THEN RAISE EXCEPTION 'Approved amount cannot be negative'; END IF;
    IF v_amount > COALESCE(v_line.line_total, 0) THEN
      RAISE EXCEPTION 'Approved amount cannot exceed the requested amount (%)', COALESCE(v_line.line_total,0);
    END IF;
  ELSE
    v_amount := 0;
  END IF;

  UPDATE budget_submission_lines
     SET status = p_decision, approved_amount = v_amount, decision_note = NULLIF(trim(COALESCE(p_note,'')),''),
         decided_by = v_uid, decided_at = now()
   WHERE id = p_line_id;

  UPDATE budget_submissions
     SET approved_total = (SELECT COALESCE(SUM(approved_amount),0) FROM budget_submission_lines
                            WHERE submission_id = v_line.submission_id AND status = 'approved'),
         status = 'under_review', reviewed_by = v_uid
   WHERE id = v_line.submission_id;

  PERFORM public.budget_log_event(v_line.submission_id, 'cfo_line_decision', jsonb_build_object(
    'line_id', p_line_id, 'description', v_line.description,
    'decision_before', v_line.status, 'decision_after', p_decision,
    'amount_before', v_line.approved_amount, 'amount_after', v_amount,
    'requested_amount', v_line.line_total, 'note', NULLIF(trim(COALESCE(p_note,'')),'')));

  RETURN jsonb_build_object('line_id', p_line_id, 'status', p_decision, 'approved_amount', v_amount);
END; $$;

CREATE OR REPLACE FUNCTION public.budget_finalize_submission(p_submission_id uuid, p_decision text, p_comment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_sub budget_submissions; v_approved numeric; v_pending int;
BEGIN
  IF NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
  SELECT * INTO v_sub FROM budget_submissions WHERE id = p_submission_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF v_sub.status NOT IN ('submitted','under_review') THEN RAISE EXCEPTION 'Cannot finalise in status %', v_sub.status; END IF;

  IF p_decision = 'approved' THEN
    SELECT COUNT(*) INTO v_pending FROM budget_submission_lines
      WHERE submission_id = p_submission_id AND status = 'pending';
    IF v_pending > 0 THEN RAISE EXCEPTION 'Decide all % remaining line item(s) first', v_pending; END IF;
  ELSE
    IF p_comment IS NULL OR length(trim(p_comment)) < 10 THEN
      RAISE EXCEPTION 'Provide a rejection reason of at least 10 characters';
    END IF;
    UPDATE budget_submission_lines SET status = 'rejected', approved_amount = 0, decided_by = v_uid, decided_at = now()
      WHERE submission_id = p_submission_id AND status <> 'rejected';
  END IF;

  SELECT COALESCE(SUM(approved_amount),0) INTO v_approved FROM budget_submission_lines
    WHERE submission_id = p_submission_id AND status = 'approved';

  UPDATE budget_submissions
     SET status = p_decision, approved_total = v_approved, reviewed_at = now(), reviewed_by = v_uid,
         cfo_comment = COALESCE(NULLIF(trim(COALESCE(p_comment,'')),''), cfo_comment)
   WHERE id = p_submission_id;

  PERFORM public.budget_notify(v_sub.submitted_by_user_id,
     CASE WHEN p_decision = 'approved' THEN 'Budget approved' ELSE 'Budget rejected' END,
     'Budget '||v_sub.reference||' was '||p_decision||'.'||COALESCE(' '||NULLIF(trim(COALESCE(p_comment,'')),''),''),
     jsonb_build_object('submission_id', p_submission_id, 'approved_total', v_approved));

  IF public.budget_department_route(v_sub.department_id) = 'coo' THEN
    PERFORM public.budget_notify(ur.user_id,
      CASE WHEN p_decision = 'approved' THEN 'CFO approved an operations budget' ELSE 'CFO rejected an operations budget' END,
      'Budget '||v_sub.reference||' was '||p_decision||' by the CFO.',
      jsonb_build_object('submission_id', p_submission_id))
    FROM user_roles ur WHERE ur.role = 'coo';
  END IF;

  PERFORM public.budget_log_event(p_submission_id, 'cfo_finalized', jsonb_build_object(
    'status_before', v_sub.status, 'status_after', p_decision,
    'approved_total_before', v_sub.approved_total, 'approved_total_after', v_approved,
    'comment', NULLIF(trim(COALESCE(p_comment,'')),'')));

  RETURN jsonb_build_object('submission_id', p_submission_id, 'status', p_decision, 'approved_total', v_approved);
END; $$;

CREATE OR REPLACE FUNCTION public.budget_request_revision(p_submission_id uuid, p_comment text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_sub budget_submissions; v_new uuid;
BEGIN
  IF NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF p_comment IS NULL OR length(trim(p_comment)) < 10 THEN
    RAISE EXCEPTION 'Provide a revision reason of at least 10 characters';
  END IF;
  SELECT * INTO v_sub FROM budget_submissions WHERE id = p_submission_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF v_sub.status NOT IN ('submitted','under_review') THEN RAISE EXCEPTION 'Cannot request revision in status %', v_sub.status; END IF;

  UPDATE budget_submissions
     SET status = 'revision_requested', cfo_comment = trim(p_comment), reviewed_at = now(), reviewed_by = v_uid
   WHERE id = p_submission_id;

  INSERT INTO budget_submissions(call_id, department_id, reference, title, purpose, status, period_type,
      period_start, period_end, submitted_by_user_id, submitted_by_position_id, total_amount,
      version, parent_submission_id)
  VALUES (v_sub.call_id, v_sub.department_id,
      v_sub.reference||'-R'||(v_sub.version + 1), v_sub.title, v_sub.purpose, 'draft', v_sub.period_type,
      v_sub.period_start, v_sub.period_end, v_sub.submitted_by_user_id, v_sub.submitted_by_position_id, 0,
      v_sub.version + 1, p_submission_id)
  RETURNING id INTO v_new;

  INSERT INTO budget_submission_lines(submission_id, sort_order, description, category, account_code,
      quantity, unit_amount, period_month, justification, document_path, status)
  SELECT v_new, sort_order, description, category, account_code, quantity, unit_amount,
         period_month, justification, document_path, 'pending'
  FROM budget_submission_lines WHERE submission_id = p_submission_id ORDER BY sort_order;

  UPDATE budget_submissions
     SET total_amount = (SELECT COALESCE(SUM(line_total),0) FROM budget_submission_lines WHERE submission_id = v_new)
   WHERE id = v_new;

  PERFORM public.budget_notify(v_sub.submitted_by_user_id, 'Budget revision requested',
      'Budget '||v_sub.reference||' needs revision: '||trim(p_comment),
      jsonb_build_object('submission_id', p_submission_id, 'new_submission_id', v_new));

  PERFORM public.budget_log_event(p_submission_id, 'revision_requested', jsonb_build_object(
    'status_before', v_sub.status, 'status_after','revision_requested',
    'comment', trim(p_comment), 'new_submission_id', v_new));

  RETURN v_new;
END; $$;

-- 7. Single-trip review queue (live totals from line items, department, route, stage counts)
CREATE OR REPLACE FUNCTION public.budget_review_queue(p_call_id uuid, p_stage text DEFAULT 'cfo')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_rows jsonb;
BEGIN
  IF p_stage NOT IN ('cfo','coo') THEN RAISE EXCEPTION 'Invalid stage'; END IF;
  IF p_stage = 'cfo' AND NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF p_stage = 'coo' AND NOT public.is_budget_coo_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'submitted_at' DESC NULLS LAST), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'id', s.id, 'reference', s.reference, 'title', s.title, 'purpose', s.purpose,
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
END; $$;
GRANT EXECUTE ON FUNCTION public.budget_review_queue(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.budget_coo_start_review(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.budget_coo_decide_line(uuid, text, numeric, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.budget_coo_forward_submission(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.budget_coo_return_submission(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.budget_log_event(uuid, text, jsonb) TO authenticated, service_role;
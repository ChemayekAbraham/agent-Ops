-- Operations budget hierarchy: scope first-level approval to the Head of
-- Operations, and forbid self-approval at BOTH stages.
--
-- WHAT WAS WRONG
--
-- 1. First-level approval was role-based, not hierarchy-based.
--    is_budget_coo_reviewer() = has_role('coo') OR has_role('super_admin'),
--    which qualified NINE users to approve the four subordinate Operations
--    budgets: Angwen Sarah, ATUHAIRE CAROLYNE, Benjamin Muhanguzi, bwayo mark,
--    HELLEN NABUKENYA, JOSHUA WANDA, Kabahuma Lillian, LUKODDA JOSEPH and
--    SSENKAALI PIUS. Joseph had no special standing.
--
-- 2. Self-approval was possible at the first level. ATUHAIRE CAROLYNE heads
--    Partner Ops (so budget_can_file_for_department passes) AND holds role
--    'coo' (so is_budget_coo_reviewer passes). None of the four budget_coo_*
--    functions compared the actor against submitted_by_user_id, so she could
--    approve her own Partner Ops budget.
--
-- 3. Self-approval was possible at the CFO stage for ALL FIVE heads.
--    is_budget_reviewer() includes 'manager', which Nsubuga, Jane, Carol,
--    Grace and Joseph all hold. budget_finalize_submission, budget_decide_line,
--    budget_request_revision and budget_start_review checked only that role,
--    never the submitter. Joseph's own Operations budget routes 'direct', so it
--    reaches status 'submitted' immediately and he could finalise it himself.
--
-- 4. The Operations parent/child hierarchy existed nowhere in data:
--    hr_departments has no parent column and budget_department_routes had no
--    reviewer column.
--
-- WHAT WAS ALREADY CORRECT AND IS PRESERVED
--   * Routing: the four subordinates carry explicit budget_department_routes
--     rows with route='coo'; 'operations' falls through to 'direct', so
--     Joseph's own budget already bypasses first-level review.
--   * Filing: budget_can_file_for_department already returns true for each head
--     against the department they head. No HR record is touched.
--   * Visibility: the budget_my_submissions fix stays exactly as applied.
--   * CFO sequencing: budget_review_queue still admits a 'coo'-routed
--     submission to the CFO stage only when coo_reviewed_at IS NOT NULL AND a
--     'coo_forwarded' event exists.
--
-- HOW JOSEPH RESOLVES (data-driven, not hard-coded)
--   budget_department_routes.reviewer_department_id -> operations
--     -> budget_department_heads (department_id=operations, active)
--       -> LUKODDA JOSEPH
-- Replacing the Head of Operations is a row update in budget_department_heads;
-- no code changes.
--
-- is_budget_reviewer() IS DELIBERATELY NOT CHANGED. 17 users hold 'manager' and
-- therefore retain CFO-stage authority. The self-approval guards below close the
-- "approve your own" hole, but manager-holders can still approve EACH OTHER's
-- budgets. That is recorded as residual risk for a separate decision, per
-- explicit instruction not to touch it here.

-- ---------------------------------------------------------------- M1: hierarchy
ALTER TABLE public.budget_department_routes
  ADD COLUMN IF NOT EXISTS reviewer_department_id uuid REFERENCES public.hr_departments(id);

COMMENT ON COLUMN public.budget_department_routes.reviewer_department_id IS
  'Department whose active head performs first-level budget review for this department. NULL keeps the legacy role-based COO behaviour.';

UPDATE public.budget_department_routes
   SET reviewer_department_id = '560ddf17-189e-4dc8-92de-36701edbd411',  -- Operations
       updated_at = now()
 WHERE department_id IN (
   '7be5acd3-7d5d-4d84-8f86-35ca58f3666b',  -- Tenant Ops
   '9e2e8c8e-2348-4e88-8507-2b916d47989c',  -- Landlord Ops
   'd76be2ac-fc3e-4f0a-9ab0-5c9ad6da2c6d',  -- Partner Ops
   '3855b76d-2fb1-4590-88e9-178b3dbd4801'   -- Agent Ops
 );

-- Which department's head reviews submissions for _department_id?
CREATE OR REPLACE FUNCTION public.budget_first_level_reviewer_dept(_department_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT r.reviewer_department_id
    FROM public.budget_department_routes r
   WHERE r.department_id = _department_id;
$$;

-- May _user_id perform first-level review for _department_id?
-- True only for an ACTIVE head of the configured reviewer department.
CREATE OR REPLACE FUNCTION public.budget_can_first_level_review(_user_id uuid, _department_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT _user_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.budget_department_heads h
        WHERE h.active
          AND h.user_id = _user_id
          AND h.department_id = public.budget_first_level_reviewer_dept(_department_id)
     );
$$;

-- Single place expressing the whole first-level gate, so the four budget_coo_*
-- functions cannot drift apart.
CREATE OR REPLACE FUNCTION public.budget_may_first_level_act(_user_id uuid, _submission_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.budget_submissions s
     WHERE s.id = _submission_id
       AND public.budget_department_route(s.department_id) = 'coo'
       -- Nobody may act on their own submission.
       AND s.submitted_by_user_id IS DISTINCT FROM _user_id
       AND (
         public.budget_can_first_level_review(_user_id, s.department_id)
         -- Departments outside the new mapping keep legacy behaviour.
         OR (public.budget_first_level_reviewer_dept(s.department_id) IS NULL
             AND public.is_budget_coo_reviewer(_user_id))
         OR public.has_role(_user_id, 'super_admin')
       )
  );
$$;

-- ------------------------------------------------- M2: first-level gate + guard
CREATE OR REPLACE FUNCTION public.budget_coo_start_review(p_submission_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_sub budget_submissions;
BEGIN
  SELECT * INTO v_sub FROM budget_submissions WHERE id = p_submission_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF v_sub.submitted_by_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot review your own budget submission';
  END IF;
  IF NOT public.budget_may_first_level_act(auth.uid(), p_submission_id) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  UPDATE budget_submissions SET coo_reviewed_by = auth.uid(), status = 'coo_under_review'
   WHERE id = p_submission_id AND status = 'pending_coo';
END;
$function$;

CREATE OR REPLACE FUNCTION public.budget_coo_decide_line(
  p_line_id uuid, p_decision text, p_approved_amount numeric, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_sub budget_submissions; v_line budget_submission_lines; v_amount numeric;
BEGIN
  SELECT * INTO v_line FROM budget_submission_lines WHERE id = p_line_id;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'Budget line not found'; END IF;
  SELECT * INTO v_sub FROM budget_submissions WHERE id = v_line.submission_id;
  IF v_sub.submitted_by_user_id = v_uid THEN
    RAISE EXCEPTION 'You cannot decide lines on your own budget submission';
  END IF;
  IF NOT public.budget_may_first_level_act(v_uid, v_sub.id) THEN
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
END;
$function$;

CREATE OR REPLACE FUNCTION public.budget_coo_forward_submission(p_submission_id uuid, p_comment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_uid uuid := auth.uid(); v_sub budget_submissions; v_pending int; v_approved numeric;
BEGIN
  SELECT * INTO v_sub FROM budget_submissions WHERE id = p_submission_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF v_sub.submitted_by_user_id = v_uid THEN
    RAISE EXCEPTION 'You cannot approve your own budget submission';
  END IF;
  IF NOT public.budget_may_first_level_act(v_uid, p_submission_id) THEN
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

  PERFORM public.budget_notify(ur.user_id, 'Operations budget approved by Head of Operations',
    'Budget '||v_sub.reference||' passed first-level review and is now in the CFO queue.',
    jsonb_build_object('submission_id', p_submission_id, 'stage','cfo'))
  FROM user_roles ur WHERE ur.role = 'cfo';

  PERFORM public.budget_notify(v_sub.submitted_by_user_id, 'Your budget was approved by the Head of Operations',
    'Budget '||v_sub.reference||' was approved and forwarded to the CFO.',
    jsonb_build_object('submission_id', p_submission_id));

  PERFORM public.budget_log_event(p_submission_id, 'coo_forwarded', jsonb_build_object(
    'status_before', v_sub.status, 'status_after','submitted',
    'coo_approved_total', v_approved, 'comment', NULLIF(trim(COALESCE(p_comment,'')),'')));

  RETURN jsonb_build_object('submission_id', p_submission_id, 'status','submitted', 'coo_approved_total', v_approved);
END;
$function$;

CREATE OR REPLACE FUNCTION public.budget_coo_return_submission(
  p_submission_id uuid, p_decision text, p_comment text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_uid uuid := auth.uid(); v_sub budget_submissions; v_new uuid;
BEGIN
  SELECT * INTO v_sub FROM budget_submissions WHERE id = p_submission_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF v_sub.submitted_by_user_id = v_uid THEN
    RAISE EXCEPTION 'You cannot return your own budget submission';
  END IF;
  IF NOT public.budget_may_first_level_act(v_uid, p_submission_id) THEN
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
     CASE WHEN p_decision = 'rejected' THEN 'Head of Operations rejected your budget'
          ELSE 'Head of Operations requested a budget revision' END,
     'Budget '||v_sub.reference||': '||trim(p_comment),
     jsonb_build_object('submission_id', p_submission_id, 'new_submission_id', v_new));

  PERFORM public.budget_log_event(p_submission_id, 'coo_returned', jsonb_build_object(
    'status_before', v_sub.status, 'status_after', p_decision,
    'comment', trim(p_comment), 'new_submission_id', v_new));

  RETURN v_new;
END;
$function$;

-- ------------------------------------------------------ M3: CFO-stage guards
CREATE OR REPLACE FUNCTION public.budget_start_review(p_submission_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF NOT public.is_budget_reviewer(auth.uid()) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF EXISTS (SELECT 1 FROM budget_submissions s
              WHERE s.id = p_submission_id AND s.submitted_by_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'You cannot review your own budget submission';
  END IF;
  UPDATE budget_submissions SET status = 'under_review', reviewed_by = auth.uid()
   WHERE id = p_submission_id AND status IN ('submitted','under_review');
END;
$function$;

CREATE OR REPLACE FUNCTION public.budget_decide_line(
  p_line_id uuid, p_decision text, p_approved_amount numeric, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_uid uuid := auth.uid(); v_line budget_submission_lines; v_status text; v_amount numeric;
BEGIN
  IF NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF p_decision NOT IN ('approved','rejected','revision_requested','pending') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
  SELECT * INTO v_line FROM budget_submission_lines WHERE id = p_line_id;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'Budget line not found'; END IF;
  IF EXISTS (SELECT 1 FROM budget_submissions s
              WHERE s.id = v_line.submission_id AND s.submitted_by_user_id = v_uid) THEN
    RAISE EXCEPTION 'You cannot decide lines on your own budget submission';
  END IF;
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
END;
$function$;

CREATE OR REPLACE FUNCTION public.budget_request_revision(p_submission_id uuid, p_comment text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_uid uuid := auth.uid(); v_sub budget_submissions; v_new uuid;
BEGIN
  IF NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF p_comment IS NULL OR length(trim(p_comment)) < 10 THEN
    RAISE EXCEPTION 'Provide a revision reason of at least 10 characters';
  END IF;
  SELECT * INTO v_sub FROM budget_submissions WHERE id = p_submission_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF v_sub.submitted_by_user_id = v_uid THEN
    RAISE EXCEPTION 'You cannot request revision on your own budget submission';
  END IF;
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
END;
$function$;

CREATE OR REPLACE FUNCTION public.budget_finalize_submission(
  p_submission_id uuid, p_decision text, p_comment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_uid uuid := auth.uid(); v_sub budget_submissions; v_approved numeric; v_pending int; v_rev uuid;
BEGIN
  IF NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
  SELECT * INTO v_sub FROM budget_submissions WHERE id = p_submission_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
  -- Nobody finalises their own budget. This is what stops Joseph approving his
  -- own Operations budget, which routes 'direct' and so lands in the CFO stage
  -- immediately while he also holds 'manager'.
  IF v_sub.submitted_by_user_id = v_uid THEN
    RAISE EXCEPTION 'You cannot approve your own budget submission';
  END IF;
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

  -- Inform the first-level reviewer (Head of Operations) rather than every
  -- 'coo' role holder. Never the submitter, who was notified above.
  IF public.budget_department_route(v_sub.department_id) = 'coo' THEN
    v_rev := public.budget_first_level_reviewer_dept(v_sub.department_id);
    IF v_rev IS NOT NULL AND EXISTS (
         SELECT 1 FROM budget_department_heads h WHERE h.department_id = v_rev AND h.active) THEN
      PERFORM public.budget_notify(h.user_id,
        CASE WHEN p_decision = 'approved' THEN 'CFO approved an Operations budget'
             ELSE 'CFO rejected an Operations budget' END,
        'Budget '||v_sub.reference||' was '||p_decision||' by the CFO.',
        jsonb_build_object('submission_id', p_submission_id))
      FROM budget_department_heads h
      WHERE h.department_id = v_rev AND h.active
        AND h.user_id IS DISTINCT FROM v_sub.submitted_by_user_id;
    ELSE
      PERFORM public.budget_notify(ur.user_id,
        CASE WHEN p_decision = 'approved' THEN 'CFO approved an operations budget'
             ELSE 'CFO rejected an operations budget' END,
        'Budget '||v_sub.reference||' was '||p_decision||' by the CFO.',
        jsonb_build_object('submission_id', p_submission_id))
      FROM user_roles ur WHERE ur.role = 'coo';
    END IF;
  END IF;

  PERFORM public.budget_log_event(p_submission_id, 'cfo_finalized', jsonb_build_object(
    'status_before', v_sub.status, 'status_after', p_decision,
    'approved_total_before', v_sub.approved_total, 'approved_total_after', v_approved,
    'comment', NULLIF(trim(COALESCE(p_comment,'')),'')));

  RETURN jsonb_build_object('submission_id', p_submission_id, 'status', p_decision, 'approved_total', v_approved);
END;
$function$;

-- ------------------------------------------------------- M4: notify Joseph only
CREATE OR REPLACE FUNCTION public.budget_submit_submission(p_submission_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_sub budget_submissions; v_call budget_calls;
  v_late boolean := false; v_lines int; v_route text; v_status text; v_total numeric; v_rev uuid;
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
    v_rev := public.budget_first_level_reviewer_dept(v_sub.department_id);
    IF v_rev IS NOT NULL AND EXISTS (
         SELECT 1 FROM budget_department_heads h WHERE h.department_id = v_rev AND h.active) THEN
      -- Head of the parent department only. The submitter is never told their
      -- own budget awaits their approval.
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
END;
$function$;

-- --------------------------------------------- M4: queue scoping (no UI change)
-- The stage gate stays permissive so a future Head of Operations without the
-- 'coo' role can still open the queue; the ROWS are what get scoped, and a
-- caller never sees their own submission awaiting their own approval.
CREATE OR REPLACE FUNCTION public.budget_review_queue(p_call_id uuid DEFAULT NULL, p_stage text DEFAULT 'cfo')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_uid uuid := auth.uid(); v_rows jsonb;
BEGIN
  IF p_stage NOT IN ('cfo','coo') THEN RAISE EXCEPTION 'Invalid stage'; END IF;
  IF p_stage = 'cfo' AND NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF p_stage = 'coo'
     AND NOT public.is_budget_coo_reviewer(v_uid)
     AND NOT EXISTS (SELECT 1 FROM budget_department_heads h WHERE h.user_id = v_uid AND h.active)
  THEN RAISE EXCEPTION 'Not authorised'; END IF;

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
      -- No reviewer ever sees their own submission in an approval queue.
      AND s.submitted_by_user_id IS DISTINCT FROM v_uid
      AND (
        (p_stage = 'coo'
          AND public.budget_department_route(s.department_id) = 'coo'
          AND s.status <> 'draft'
          AND (
            public.budget_can_first_level_review(v_uid, s.department_id)
            OR (public.budget_first_level_reviewer_dept(s.department_id) IS NULL
                AND public.is_budget_coo_reviewer(v_uid))
            OR public.has_role(v_uid, 'super_admin')
          ))
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
$function$;

-- --------------------------------------------------------------- assertions
DO $$
DECLARE v_n integer; v_ops uuid := '560ddf17-189e-4dc8-92de-36701edbd411';
        v_joseph uuid := 'b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c';
BEGIN
  SELECT count(*) INTO v_n FROM budget_department_routes WHERE reviewer_department_id = v_ops;
  IF v_n <> 4 THEN RAISE EXCEPTION 'expected 4 subordinate routes pointing at Operations, found %', v_n; END IF;

  -- Joseph reviews all four; nobody else does.
  FOR v_n IN SELECT 1 FROM budget_department_routes r WHERE r.reviewer_department_id = v_ops
  LOOP NULL; END LOOP;

  SELECT count(*) INTO v_n
    FROM budget_department_routes r
   WHERE r.reviewer_department_id = v_ops
     AND public.budget_can_first_level_review(v_joseph, r.department_id);
  IF v_n <> 4 THEN RAISE EXCEPTION 'Joseph does not resolve as reviewer for all 4 (%).', v_n; END IF;

  -- Carol must NOT be able to review Partner Ops (the department she heads).
  IF public.budget_can_first_level_review(
       'ae194750-4827-47e8-839e-5e772565138b',
       'd76be2ac-fc3e-4f0a-9ab0-5c9ad6da2c6d') THEN
    RAISE EXCEPTION 'Carol still resolves as first-level reviewer for Partner Ops';
  END IF;

  -- Operations itself must remain a direct-to-CFO route.
  IF public.budget_department_route(v_ops) <> 'direct' THEN
    RAISE EXCEPTION 'Operations route changed unexpectedly';
  END IF;

  -- The visibility fix must still be in place.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'budget_my_submissions'
     AND position('budget_user_department_ids' in p.prosrc) > 0
     AND position('budget_home_department_id' in p.prosrc) = 0;
  IF v_n <> 1 THEN RAISE EXCEPTION 'budget_my_submissions visibility fix was disturbed'; END IF;
END $$;
